# S4 cloud half: Yoal's pinned Caddy exactly as .github/workflows/release.yml builds it
# (Caddy 2.11.8, xcaddy v0.4.7, Go 1.24, caddy-dns/cloudflare v0.2.4; no other module). Caddy
# 2.11.8 declares `go 1.26.0`, so Go 1.24 builds it only by fetching that toolchain (GOTOOLCHAIN=auto,
# as setup-go allows in release.yml).
FROM golang:1.24-alpine AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=auto
RUN apk add --no-cache git && go install "github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7" \
 && xcaddy build v2.11.8 --with "github.com/caddy-dns/cloudflare@v0.2.4" --output /caddy \
 && /caddy version && /caddy build-info | grep -E 'caddyserver/(caddy|certmagic)|mholt/acmez|libdns|caddy-dns|^go' > /build-info.txt
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /caddy /usr/bin/caddy
COPY --from=build /build-info.txt /etc/s4-build-info.txt
ENTRYPOINT ["/usr/bin/caddy"]
