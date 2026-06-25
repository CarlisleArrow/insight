package telemetry

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds the BFF's Prometheus collectors.
type Metrics struct {
	RequestsTotal *prometheus.CounterVec
	QueriesTotal  *prometheus.CounterVec // labelled by engine (trino|clickhouse)
}

// NewMetrics registers and returns the control-plane metrics.
func NewMetrics() *Metrics {
	return &Metrics{
		RequestsTotal: promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "cp_http_requests_total",
			Help: "Total BFF HTTP requests by route and status.",
		}, []string{"route", "status"}),
		QueriesTotal: promauto.NewCounterVec(prometheus.CounterOpts{
			Name: "cp_queries_total",
			Help: "Total queries routed to an execution engine.",
		}, []string{"engine"}),
	}
}

// Handler exposes /metrics for Prometheus scraping.
func (m *Metrics) Handler() http.Handler { return promhttp.Handler() }
