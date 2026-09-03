FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code + migrations (alembic/ and alembic.ini are required
# at runtime: the entrypoint applies migrations before serving).
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini entrypoint.sh ./

# Run as a non-root user.
RUN useradd --create-home --uid 1000 appuser
USER appuser

EXPOSE 8000

CMD ["./entrypoint.sh"]
