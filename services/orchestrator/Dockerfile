FROM python:3.11-slim
WORKDIR /app
COPY services/common/requirements.txt ./common-requirements.txt
RUN pip install --no-cache-dir -r common-requirements.txt
COPY services/orchestrator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/common ./common
COPY services/orchestrator/orchestrator.py services/orchestrator/lyzr_client.py ./
CMD ["python", "orchestrator.py"]
