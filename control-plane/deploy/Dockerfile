# Multi-stage build for the control-plane BFF.
# Push to Harbor: 172.16.202.30/ipas/control-plane:<git-sha> (§12.2).
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# The DAG template is baked from GitLab at build time (§8.1); it lives in the
# source tree under internal/adapter/airflow.
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/server /app/server
COPY internal/config/config.yaml /etc/control-plane/config.yaml
EXPOSE 8088
USER nonroot:nonroot
ENTRYPOINT ["/app/server", "-config", "/etc/control-plane/config.yaml"]
