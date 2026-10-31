#!/usr/bin/env sh
# Ollama entrypoint that self-provisions the models the stack needs.
#
# Starts `ollama serve` in the background, waits for its HTTP API, pulls the
# embedding + generation models (idempotent — a pull of an already-present model
# is a fast no-op), then waits on the server process so the container stays up.
#
# Models (overridable via env):
#   EMBED_MODEL  default nomic-embed-text  (768-dim embeddings)
#   GEN_MODEL    default llama3.1          (generation)
#
# The compose healthcheck (see docker-compose.yml) reports this service healthy
# only once BOTH models appear in `ollama list`, so `api` (depends_on ollama
# healthy) does not seed/serve until the models are actually available.
set -eu

EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
GEN_MODEL="${GEN_MODEL:-llama3.1}"

echo "ollama-entrypoint: starting server"
ollama serve &
SERVER_PID=$!

echo "ollama-entrypoint: waiting for API on 127.0.0.1:11434"
until ollama list >/dev/null 2>&1; do
  sleep 1
done

echo "ollama-entrypoint: pulling ${EMBED_MODEL}"
ollama pull "${EMBED_MODEL}"
echo "ollama-entrypoint: pulling ${GEN_MODEL}"
ollama pull "${GEN_MODEL}"
echo "ollama-entrypoint: models ready"

wait "${SERVER_PID}"
