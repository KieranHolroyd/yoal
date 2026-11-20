# The checker app as a container app. Build from this directory:
#   docker build -t yoal-w0-checker-app tests/ha/checker/app
FROM oven/bun:1.3-slim
WORKDIR /app
COPY package.json server.ts ./
ENV PORT=8080
EXPOSE 8080
USER bun
CMD ["bun", "server.ts"]
