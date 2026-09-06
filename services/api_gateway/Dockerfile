FROM python:3.11-slim
WORKDIR /app
COPY services/common/requirements.txt ./common-requirements.txt
RUN pip install --no-cache-dir -r common-requirements.txt
COPY services/api_gateway/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/common ./common
COPY services/api_gateway/main.py .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
