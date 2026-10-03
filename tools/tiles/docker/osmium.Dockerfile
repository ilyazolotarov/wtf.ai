# osmium-tool for local builds on machines without it (Windows). CI installs it with apt.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["osmium"]
