from fastapi import (
    FastAPI,
    UploadFile,
    File as UploadFileField,
    HTTPException,
    Query,
    Depends,
    Header,
    Request,
)
from fastapi.responses import JSONResponse, StreamingResponse, Response
from sqlalchemy import select, update, text
from database import engine, SessionLocal, Base
from models import FileModel, FileVersionModel, UploadRequestModel
from minio import Minio
from prometheus_client import (
    Counter,
    Histogram,
    Gauge,
    generate_latest,
    CONTENT_TYPE_LATEST,
)
from minio.sse import SseS3
from starlette.background import BackgroundTask
from sqlalchemy.exc import IntegrityError
from fastapi.middleware.cors import CORSMiddleware

import uuid
import hashlib
import os
import tempfile
import time
import uvicorn
import psutil
import asyncio
from typing import Optional
import json

# --- Config ---
SERVER_NAME = os.environ.get("SERVER_NAME", "app")
MINIO_BUCKET = os.environ.get("MINIO_BUCKET", "files")
API_KEY = os.environ.get("API_KEY", "supersecretkey")
ADMIN_KEY = os.environ.get("ADMIN_KEY")

# MinIO via env (ready for TLS)
MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "testadmin123")
MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "testadmin321")
MINIO_SECURE = os.environ.get("MINIO_SECURE", "false").lower() == "true"
MINIO_SSE = os.environ.get("MINIO_SSE", "false").lower() == "true"

minio_client = Minio(
    MINIO_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=MINIO_SECURE,
)

# --- Prometheus metrics ---
REQUEST_COUNT = Counter(
    "file_requests_total", "Total HTTP requests", ["method", "endpoint", "status"]
)

REQUEST_LATENCY = Histogram(
    "file_request_latency_seconds",
    "Latency of file requests (seconds)",
    ["endpoint"],
    buckets=(0.05, 0.1, 0.2, 0.5, 1, 2, 5),
)

CPU = Gauge("app_cpu_percent", "CPU percent")
MEM = Gauge("app_mem_bytes", "Resident memory bytes")

# --- FastAPI app ---
app = FastAPI(
    title="File Repository",
    description="Versioned file store with optional client-defined directories (?dir=) and MinIO backend.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*", "X-Api-Key", "Admin-Key", "Idempotency-Key"],
)

# Node-drain flag (lets Traefik pull this instance from rotation)
DRAINING = False


# --- Root endpoint ---
@app.get("/")
async def root():
    return {"message": f"Hello from {SERVER_NAME}"}


# --- Health (lightweight; Traefik polls this) ---
@app.get("/healthz")
@app.head("/healthz")
async def health_check():
    if DRAINING:
        return JSONResponse(
            status_code=503, content={"status": "draining", "app": SERVER_NAME}
        )
    return {"status": "ok", "app": SERVER_NAME}


# --- Readiness (deep check: DB + MinIO) ---
async def _check_db() -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


async def _check_minio(bucket: str) -> bool:
    try:
        return await asyncio.to_thread(minio_client.bucket_exists, bucket)
    except Exception:
        return False


@app.get("/readyz")
async def readiness_check():
    db_ok = await _check_db()
    minio_ok = await _check_minio(MINIO_BUCKET)
    ok = db_ok and minio_ok and (not DRAINING)
    return JSONResponse(
        status_code=200 if ok else 503,
        content={
            "status": "ok" if ok else "fail",
            "db": db_ok,
            "minio": minio_ok,
            "draining": DRAINING,
            "app": SERVER_NAME,
        },
    )


# --- Optional: admin drain toggle (protect with ADMIN_KEY) ---
@app.post("/admin/drain")
async def set_drain(state: bool = Query(...), x_admin_key: str = Header(None)):
    if not ADMIN_KEY or x_admin_key != ADMIN_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")
    global DRAINING
    DRAINING = state
    return {"draining": DRAINING, "app": SERVER_NAME}


# --- Middleware: logging & metrics ---
@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start

    endpoint = request.url.path
    REQUEST_COUNT.labels(
        method=request.method, endpoint=endpoint, status=str(response.status_code)
    ).inc()
    REQUEST_LATENCY.labels(endpoint=endpoint).observe(duration)

    print(f"{request.method} {endpoint} {response.status_code} - {duration:.4f}s")
    return response


# --- API key dependency ---
async def verify_api_key(x_api_key: str = Header(...)):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


# --- Startup: create DB tables and ensure MinIO bucket exists ---
@app.on_event("startup")
async def startup_event():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        if not minio_client.bucket_exists(MINIO_BUCKET):
            minio_client.make_bucket(MINIO_BUCKET)
            print(f"Created MinIO bucket: {MINIO_BUCKET}")
    except Exception as e:
        print("MinIO bucket check/create error:", e)


# --- Prometheus metrics endpoint (update CPU/MEM on scrape) ---
@app.get("/metrics")
def metrics():
    CPU.set(psutil.cpu_percent())
    MEM.set(psutil.Process().memory_info().rss)
    data = generate_latest()
    return Response(content=data, media_type=CONTENT_TYPE_LATEST)


@app.get("/metrics/heartbeat")
async def hb():
    CPU.set(psutil.cpu_percent())
    MEM.set(psutil.Process().memory_info().rss)
    return {"ok": True}


def _safe_join(*parts: str) -> str:
    """Join path parts safely without duplicate slashes; strip leading '../'."""
    clean = []
    for p in parts:
        if not p:
            continue
        p = p.strip().strip("/")  # drop leading/trailing slashes and whitespace
        if p in (".", ".."):
            continue
        clean.append(p)
    return "/".join(clean)


# --- Upload new file (supports client-chosen dir + idempotency + optional SSE) ---
@app.post("/v1/files", dependencies=[Depends(verify_api_key)])
async def upload_file(
    file: UploadFile = UploadFileField(...),
    dir: Optional[str] = Query(None, description="Optional subdirectory"),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    # Idempotency cache hit?
    if idempotency_key:
        async with SessionLocal() as session:
            async with session.begin():
                res = await session.execute(
                    select(UploadRequestModel).where(
                        UploadRequestModel.idempotency_key == idempotency_key
                    )
                )
                found = res.scalar_one_or_none()
                if found:
                    return JSONResponse(
                        status_code=201, content=json.loads(found.result_json)
                    )

    file_id = uuid.uuid4().hex
    version = 1
    prefix = _safe_join(dir) if dir else ""
    object_key = _safe_join(prefix, file_id, f"v{version}")

    tmp = tempfile.NamedTemporaryFile(delete=False)
    h = hashlib.sha256()
    size = 0

    try:
        while chunk := await file.read(64 * 1024):
            tmp.write(chunk)
            h.update(chunk)
            size += len(chunk)

        tmp.flush()
        tmp.seek(0)
        checksum = h.hexdigest()

        sse = SseS3() if MINIO_SSE else None
        await asyncio.to_thread(
            minio_client.fput_object, MINIO_BUCKET, object_key, tmp.name, sse=sse
        )
    finally:
        tmp.close()
        try:
            os.unlink(tmp.name)
        except Exception:
            pass

    async with SessionLocal() as session:
        async with session.begin():
            new_file = FileModel(
                file_id=file_id, current_version=version, path=object_key
            )
            new_version = FileVersionModel(
                file_id=file_id,
                version=version,
                object_key=object_key,
                checksum=checksum,
                size=size,
            )
            session.add_all([new_file, new_version])

        result = {
            "file_id": file_id,
            "path": object_key,
            "version": version,
            "checksum": checksum,
            "size": size,
            "server": SERVER_NAME,
        }

    if idempotency_key:
        async with SessionLocal() as session:
            async with session.begin():
                try:
                    session.add(
                        UploadRequestModel(
                            idempotency_key=idempotency_key,
                            result_json=json.dumps(result),
                        )
                    )
                except IntegrityError:
                    # Another request inserted the same key; return its stored result
                    await session.rollback()
                    res = await session.execute(
                        select(UploadRequestModel).where(
                            UploadRequestModel.idempotency_key == idempotency_key
                        )
                    )
                    found = res.scalar_one()
                    return JSONResponse(
                        status_code=201, content=json.loads(found.result_json)
                    )

    return JSONResponse(status_code=201, content=result)


# --- Upload new version (optional SSE) ---
@app.put("/v1/files/{file_id}", dependencies=[Depends(verify_api_key)])
async def upload_new_version(file_id: str, file: UploadFile = UploadFileField(...)):
    async with SessionLocal() as session:
        async with session.begin():
            res = await session.execute(
                select(FileModel).where(FileModel.file_id == file_id)
            )
            row = res.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="file not found")
            curr_version = row.current_version
            new_version = curr_version + 1

    object_key = _safe_join(file_id, f"v{new_version}")
    tmp = tempfile.NamedTemporaryFile(delete=False)
    h = hashlib.sha256()
    size = 0

    try:
        while chunk := await file.read(64 * 1024):
            tmp.write(chunk)
            h.update(chunk)
            size += len(chunk)

        tmp.flush()
        tmp.seek(0)
        checksum = h.hexdigest()

        sse = SseS3() if MINIO_SSE else None
        await asyncio.to_thread(
            minio_client.fput_object, MINIO_BUCKET, object_key, tmp.name, sse=sse
        )
    finally:
        tmp.close()
        try:
            os.unlink(tmp.name)
        except Exception:
            pass

    async with SessionLocal() as session:
        async with session.begin():
            new_version_obj = FileVersionModel(
                file_id=file_id,
                version=new_version,
                object_key=object_key,
                checksum=checksum,
                size=size,
            )
            session.add(new_version_obj)
            await session.execute(
                update(FileModel)
                .where(FileModel.file_id == file_id)
                .values(current_version=new_version, path=object_key)
            )

    return {
        "file_id": file_id,
        "version": new_version,
        "checksum": checksum,
        "size": size,
        "server": SERVER_NAME,
    }


# --- Download by file_id (latest or specific version) ---
@app.get("/v1/files/{file_id}", dependencies=[Depends(verify_api_key)])
async def download_file(file_id: str, version: int | None = Query(None)):
    async with SessionLocal() as session:
        async with session.begin():
            if version is None:
                res = await session.execute(
                    select(FileModel).where(FileModel.file_id == file_id)
                )
                row = res.scalar_one_or_none()
                if not row:
                    raise HTTPException(status_code=404, detail="file not found")
                version = row.current_version

            res = await session.execute(
                select(FileVersionModel).where(
                    (FileVersionModel.file_id == file_id)
                    & (FileVersionModel.version == version)
                )
            )
            vrow = res.scalar_one_or_none()
            if not vrow:
                raise HTTPException(status_code=404, detail="file version not found")

    obj = minio_client.get_object(MINIO_BUCKET, vrow.object_key)

    def body():
        for data in obj.stream(32 * 1024):
            yield data

    def cleanup():
        try:
            obj.close()
        finally:
            try:
                obj.release_conn()
            except Exception:
                pass

    headers = {
        "Content-Disposition": f'attachment; filename="{file_id}_v{version}"',
    }
    if vrow.checksum:
        headers["ETag"] = vrow.checksum

    return StreamingResponse(
        body(),
        media_type="application/octet-stream",
        headers=headers,
        background=BackgroundTask(cleanup),
    )


# --- Delete file (all versions) ---
@app.delete("/v1/files/{file_id}", dependencies=[Depends(verify_api_key)])
async def delete_file(file_id: str):
    async with SessionLocal() as session:
        async with session.begin():
            res = await session.execute(
                select(FileModel).where(FileModel.file_id == file_id)
            )
            row = res.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="file not found")

            versions_res = await session.execute(
                select(FileVersionModel).where(FileVersionModel.file_id == file_id)
            )
            versions = versions_res.scalars().all()

            for v in versions:
                try:
                    await asyncio.to_thread(
                        minio_client.remove_object, MINIO_BUCKET, v.object_key
                    )
                except Exception as e:
                    print("MinIO remove_object error:", e)

            await session.execute(
                update(FileModel)
                .where(FileModel.file_id == file_id)
                .values(deleted=True)
            )
            await session.execute(
                FileVersionModel.__table__.delete().where(
                    FileVersionModel.file_id == file_id
                )
            )

    return {"status": "deleted", "file_id": file_id}


# --- Run (HTTP only; Traefik terminates TLS) ---
if __name__ == "__main__":
    uvicorn.run("app_server:app", host="0.0.0.0", port=8000, log_level="info")
