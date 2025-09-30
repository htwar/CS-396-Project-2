FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app

# Run as non-root (optional but recommended)
RUN useradd -m appuser
USER appuser

EXPOSE 8000

# Healthcheck (exec form; no heredoc)
HEALTHCHECK --interval=30s --timeout=3s --retries=5 \
  CMD ["python","-c","import urllib.request,sys; \
resp=urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2); \
sys.exit(0 if resp.getcode()==200 else 1)"]

CMD ["uvicorn","app_server:app","--host","0.0.0.0","--port","8000",""--proxy-headers","--workers","2"]
