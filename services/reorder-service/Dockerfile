FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY pyproject.toml ./
COPY reorder ./reorder
RUN pip install .
RUN useradd --create-home app
USER app
EXPOSE 8090
# Same image runs both processes; compose / Kubernetes pick one:
#   API:      uvicorn reorder.api:main_app --factory --host 0.0.0.0 --port 8090
#   consumer: python -m reorder.consumer
CMD ["uvicorn", "reorder.api:main_app", "--factory", "--host", "0.0.0.0", "--port", "8090"]
