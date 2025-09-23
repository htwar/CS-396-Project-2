from fastapi import FastAPI, UploadFile, File as UploadFileField, HTTPException, Query, Depends, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse, Response
from sqlalchemy import select, update
from database import engine, SessionLocal, Base
from models import FileModel, FileVersionModel
from minio import Minio
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

import uuid
import hashlib
import os
import tempfile
import time
import uvicorn
import urllib3

# --- Config ---
SERVER_NAME = os.environ.get("SERVER_NAME", "app1")
MINIO_BUCKET = os.environ.get("MINIO_BUCKET", "files")
API_KEY = os.environ.get("API_KEY", "supersecretkey")

# --- Initialize MinIO client ---
http_client = urllib3.PoolManager(
    cert_reqs="CERT_REQUIRED",
    ca_certs="/etc/ssl/certs/minio.crt"
)

minio_client = Minio(
    "minio:9000",
    access_key="minioadmin",
    secret_key="minioadmin",
    secure=False,
)

# --- Prometheus metrics ---
REQUEST_COUNT = Counter("file_requests_total", "Total HTTP requests", ["method", "endpoint", "status"])
REQUEST_LATENCY = Histogram("file_request_latency_seconds", "Request latency seconds", ["endpoint"])

# --- FastAPI app ---
app = FastAPI(title="File Repository")


# --- Root endpoint for testing HTTPS + Nginx ---
@app.get("/")
async def root():
    return {"message": f"Hello from {SERVER_NAME}"}


# --- Health check ---
@app.get("/healthz")
async def health_check():
    return {"status": "ok", "app": SERVER_NAME}


# --- Middleware: logging & metrics ---
@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start

    endpoint = request.url.path
    REQUEST_COUNT.labels(method=request.method, endpoint=endpoint, status=response.status_code).inc()
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


# --- Prometheus metrics endpoint ---
@app.get("/metrics")
def metrics():
    data = generate_latest()
    return Response(content=data, media_type=CONTENT_TYPE_LATEST)


# --- Upload new file ---
@app.post("/v1/files", dependencies=[Depends(verify_api_key)])
async def upload_file(file: UploadFile = UploadFileField(...)):
    file_id = hashlib.md5(file.filename.encode()).hexdigest()
    version = 1
    object_key = f"{file_id}/v{version}"

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

        minio_client.fput_object(MINIO_BUCKET, object_key, tmp.name)
    finally:
        tmp.close()
        try:
            os.unlink(tmp.name)
        except Exception:
            pass

    async with SessionLocal() as session:
        async with session.begin():
            new_file = FileModel(file_id=file_id, current_version=version, path=object_key)
            new_version = FileVersionModel(
                file_id=file_id,
                version=version,
                object_key=object_key,
                checksum=checksum,
                size=size,
            )
            session.add_all([new_file, new_version])

    return JSONResponse(
        status_code=201,
        content={
            "file_id": file_id,
            "path": object_key,
            "version": version,
            "checksum": checksum,
            "size": size,
            "server": SERVER_NAME,
        },
    )


# --- Upload new version ---
@app.put("/v1/files/{file_id}", dependencies=[Depends(verify_api_key)])
async def upload_new_version(file_id: str, file: UploadFile = UploadFileField(...)):
    async with SessionLocal() as session:
        async with session.begin():
            res = await session.execute(select(FileModel).where(FileModel.file_id == file_id))
            row = res.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="file not found")

            curr_version = row.current_version
            new_version = curr_version + 1

    object_key = f"{file_id}/v{new_version}"
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

        minio_client.fput_object(MINIO_BUCKET, object_key, tmp.name)
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
                update(FileModel).where(FileModel.file_id == file_id).values(current_version=new_version)
            )

    return {
        "file_id": file_id,
        "version": new_version,
        "checksum": checksum,
        "size": size,
        "server": SERVER_NAME,
    }


# --- Download file ---
@app.get("/v1/files/{file_id}")
async def download_file(file_id: str, version: int = Query(None)):
    async with SessionLocal() as session:
        async with session.begin():
            if version is None:
                res = await session.execute(select(FileModel).where(FileModel.file_id == file_id))
                row = res.scalar_one_or_none()
                if not row:
                    raise HTTPException(status_code=404, detail="file not found")
                version = row.current_version

            res = await session.execute(
                select(FileVersionModel).where(
                    (FileVersionModel.file_id == file_id) & (FileVersionModel.version == version)
                )
            )
            vrow = res.scalar_one_or_none()
            if not vrow:
                raise HTTPException(status_code=404, detail="file version not found")

    obj = minio_client.get_object(MINIO_BUCKET, vrow.object_key)
    return StreamingResponse(
        obj,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{file_id}_v{version}"'},
    )


# --- Delete file ---
@app.delete("/v1/files/{file_id}", dependencies=[Depends(verify_api_key)])
async def delete_file(file_id: str):
    async with SessionLocal() as session:
        async with session.begin():
            res = await session.execute(select(FileModel).where(FileModel.file_id == file_id))
            row = res.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="file not found")

            versions_res = await session.execute(select(FileVersionModel).where(FileVersionModel.file_id == file_id))
            versions = versions_res.scalars().all()

            for v in versions:
                try:
                    minio_client.remove_object(MINIO_BUCKET, v.object_key)
                except Exception as e:
                    print("MinIO remove_object error:", e)

            await session.execute(update(FileModel).where(FileModel.file_id == file_id).values(deleted=True))
            await session.execute(FileVersionModel.__table__.delete().where(FileVersionModel.file_id == file_id))

    return {"status": "deleted", "file_id": file_id}


# --- Run with SSL ---
if __name__ == "__main__":
    import ssl

    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(
        certfile="/etc/ssl/certs/minio.crt",
        keyfile="/etc/ssl/certs/minio.key"
    )

    uvicorn.run(
        "app_server:app",
        host="0.0.0.0",
        port=8000,
        ssl_context=ssl_context,
        log_level="info"
    )
