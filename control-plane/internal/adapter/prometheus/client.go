// Package prometheus queries the Prometheus HTTP API (ARCHITECTURE.md §4:
// prometheus-k8s.kubesphere-monitoring-system:9090) for the Ops pages.
package prometheus

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/httpx"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: &http.Client{Timeout: 15 * time.Second}}
}

type queryResp struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
			Value  [2]any            `json:"value"` // [ <ts float>, "<value string>" ]
		} `json:"result"`
	} `json:"data"`
}

// Query runs an instant PromQL query and flattens vector results into samples.
func (c *Client) Query(ctx context.Context, promql string) ([]adapter.MetricSample, error) {
	var r queryResp
	u := fmt.Sprintf("%s/api/v1/query?query=%s", c.baseURL, url.QueryEscape(promql))
	if err := httpx.Do(ctx, c.http, http.MethodGet, u, nil, nil, &r); err != nil {
		return nil, fmt.Errorf("prometheus query: %w", err)
	}
	if r.Status != "success" {
		return nil, fmt.Errorf("prometheus query status: %s", r.Status)
	}
	out := make([]adapter.MetricSample, 0, len(r.Data.Result))
	for _, res := range r.Data.Result {
		name := metricLabel(res.Metric)
		val, ts := parseSample(res.Value)
		out = append(out, adapter.MetricSample{Metric: name, Value: val, Time: ts})
	}
	return out, nil
}

type rangeResp struct {
	Status string `json:"status"`
	Data   struct {
		Result []struct {
			Metric map[string]string `json:"metric"`
			Values [][2]any          `json:"values"` // [ [<ts float>, "<val>"], ... ]
		} `json:"result"`
	} `json:"data"`
}

// QueryRange runs a PromQL range query over the last `minutes` at `stepSec`
// resolution and returns one series per result vector. Time labels are HH:MM so
// they drop straight into the front-end trend/bar charts.
func (c *Client) QueryRange(ctx context.Context, promql string, minutes, stepSec int) ([]adapter.MetricSeries, error) {
	if minutes <= 0 {
		minutes = 30
	}
	if stepSec <= 0 {
		stepSec = 120
	}
	end := time.Now()
	start := end.Add(-time.Duration(minutes) * time.Minute)
	u := fmt.Sprintf("%s/api/v1/query_range?query=%s&start=%d&end=%d&step=%d",
		c.baseURL, url.QueryEscape(promql), start.Unix(), end.Unix(), stepSec)
	var r rangeResp
	if err := httpx.Do(ctx, c.http, http.MethodGet, u, nil, nil, &r); err != nil {
		return nil, fmt.Errorf("prometheus query_range: %w", err)
	}
	if r.Status != "success" {
		return nil, fmt.Errorf("prometheus query_range status: %s", r.Status)
	}
	out := make([]adapter.MetricSeries, 0, len(r.Data.Result))
	for _, res := range r.Data.Result {
		s := adapter.MetricSeries{Metric: metricLabel(res.Metric)}
		for _, v := range res.Values {
			val, _ := parseSample(v)
			var label string
			if f, ok := v[0].(float64); ok {
				label = time.Unix(int64(f), 0).Format("15:04")
			}
			s.Points = append(s.Points, adapter.MetricPoint{Time: label, Value: val})
		}
		out = append(out, s)
	}
	return out, nil
}

func metricLabel(m map[string]string) string {
	if n, ok := m["__name__"]; ok {
		return n
	}
	for k, v := range m { // fall back to any label
		return k + "=" + v
	}
	return "value"
}

func parseSample(v [2]any) (float64, string) {
	var val float64
	if s, ok := v[1].(string); ok {
		val, _ = strconv.ParseFloat(s, 64)
	}
	var ts string
	if f, ok := v[0].(float64); ok {
		ts = time.Unix(int64(f), 0).Format(time.RFC3339)
	}
	return val, ts
}
