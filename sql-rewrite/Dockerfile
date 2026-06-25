# L6 SQL-rewrite microservice image.
# Push to Harbor: 172.16.202.30/ipas/sql-rewrite:<git-sha> (§10.3, §12.2).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
