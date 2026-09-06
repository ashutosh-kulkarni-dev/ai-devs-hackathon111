FROM python:3.11-slim
WORKDIR /app
COPY services/common/requirements.txt ./common-requirements.txt
RUN pip install --no-cache-dir -r common-requirements.txt
COPY services/agents/fraud_case_search/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/common ./common
COPY services/agents/fraud_case_search/agent.py ./agent.py
CMD ["python", "agent.py"]
