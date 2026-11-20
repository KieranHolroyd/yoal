# MinIO stopped publishing community images and binaries in late 2025 (quay/Docker Hub refuse the
# pull, dl.min.io answers 410) and archived github.com/minio/minio. This builds the last release
# tag from that repository, pinned by tag and commit.
FROM golang:1.24.8-bookworm AS build
ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
RUN git clone --depth 1 --branch "$MINIO_TAG" https://github.com/minio/minio /src \
 && test "$(git -C /src rev-parse HEAD)" = "$MINIO_COMMIT"
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -tags kqueue -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/minio .

FROM debian:bookworm-slim
COPY --from=build /out/minio /usr/bin/minio
ENTRYPOINT ["/usr/bin/minio"]
