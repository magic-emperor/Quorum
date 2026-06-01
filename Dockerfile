FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir -e ".[bots,providers,server,teams,adapters]"

COPY qorum/ ./qorum/
COPY apps/ ./apps/
COPY docs/ ./docs/

ENV PYTHONUNBUFFERED=1

# 7432 = web dashboard + WebSocket
# 3978 = Teams Bot Framework /api/messages
EXPOSE 7432 3978

CMD ["python", "-m", "qorum"]
