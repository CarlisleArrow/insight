// Package datahub is the DataHub GMS client (ARCHITECTURE.md §4, §13.1:
// datahub-datahub-gms.datahub:8080). DataHub is the metadata hub — the front-end
// reads catalog search + lineage from here. Search/lineage use GraphQL; status
// upsert uses the rest.li ingestProposal API.
package datahub

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/httpx"
)

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), token: token, http: &http.Client{Timeout: 20 * time.Second}}
}

func (c *Client) headers() map[string]string {
	h := map[string]string{}
	if c.token != "" {
		h["Authorization"] = "Bearer " + c.token
	}
	return h
}

type graphQLReq struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables"`
}

const searchQuery = `query s($q: String!) {
  searchAcrossEntities(input: {types: [DATASET], query: $q, start: 0, count: 100}) {
    searchResults { entity {
      urn
      ... on Dataset {
        name
        properties { name description }
        ownership { owners { owner { ... on CorpUser { username } } } }
        glossaryTerms { terms { term { urn } } }
        datasetProfiles(limit: 1) {
          rowCount
          fieldProfiles { fieldPath nullProportion }
        }
      }
    } }
  }
}`

type searchResp struct {
	Data struct {
		SearchAcrossEntities struct {
			SearchResults []struct {
				Entity struct {
					URN        string `json:"urn"`
					Name       string `json:"name"`
					Properties struct {
						Name        string `json:"name"`
						Description string `json:"description"`
					} `json:"properties"`
					Ownership struct {
						Owners []struct {
							Owner struct {
								Username string `json:"username"`
							} `json:"owner"`
						} `json:"owners"`
					} `json:"ownership"`
					GlossaryTerms struct {
						Terms []struct {
							Term struct {
								URN string `json:"urn"`
							} `json:"term"`
						} `json:"terms"`
					} `json:"glossaryTerms"`
					DatasetProfiles []struct {
						RowCount      int `json:"rowCount"`
						FieldProfiles []struct {
							FieldPath      string   `json:"fieldPath"`
							NullProportion *float64 `json:"nullProportion"`
						} `json:"fieldProfiles"`
					} `json:"datasetProfiles"`
				} `json:"entity"`
			} `json:"searchResults"`
		} `json:"searchAcrossEntities"`
	} `json:"data"`
}

// completenessScore derives a 0–100 quality score from a dataset's latest column
// profile: the average non-null proportion across fields. Returns 0 (rendered as
// "—") when no profile has been ingested.
func completenessScore(fps []struct {
	FieldPath      string   `json:"fieldPath"`
	NullProportion *float64 `json:"nullProportion"`
}) int {
	var sum float64
	var n int
	for _, fp := range fps {
		if fp.NullProportion != nil {
			sum += 1 - *fp.NullProportion
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return int(math.Round(sum / float64(n) * 100))
}

func (c *Client) Search(ctx context.Context, q string) ([]adapter.Asset, error) {
	if q == "" {
		// Focus the default (empty) query on the QMS domain so the shared engines'
		// unrelated tables (default.eap_*, etc.) don't crowd out the result page.
		q = "qms"
	}
	var resp searchResp
	body := graphQLReq{Query: searchQuery, Variables: map[string]any{"q": q}}
	if err := httpx.Do(ctx, c.http, http.MethodPost, c.baseURL+"/api/graphql", c.headers(), body, &resp); err != nil {
		return nil, fmt.Errorf("datahub search: %w", err)
	}
	out := make([]adapter.Asset, 0, len(resp.Data.SearchAcrossEntities.SearchResults))
	for _, r := range resp.Data.SearchAcrossEntities.SearchResults {
		e := r.Entity
		// Focus the catalog on the IPAS QMS domain. The shared ClickHouse/Trino
		// instances host unrelated apps (e.g. default.eap_* telemetry tables);
		// keep only datasets whose urn belongs to the qms namespaces.
		if !inQMSDomain(e.URN) {
			continue
		}
		name := firstNonEmpty(e.Properties.Name, e.Name, datasetNameFromURN(e.URN))
		owner := ""
		if len(e.Ownership.Owners) > 0 {
			owner = e.Ownership.Owners[0].Owner.Username
		}
		score := 0
		if len(e.DatasetProfiles) > 0 {
			score = completenessScore(e.DatasetProfiles[0].FieldProfiles)
		}
		out = append(out, adapter.Asset{
			URN:   e.URN,
			Name:  name,
			Layer: layerFor(name),
			Desc:  e.Properties.Description,
			Owner: owner,
			Score: score,
			Sens:  sensFromTerms(e.GlossaryTerms.Terms),
		})
	}
	return out, nil
}

const lineageQuery = `query l($urn: String!) {
  entity(urn: $urn) {
    urn
    ... on Dataset {
      upstream: lineage(input: {direction: UPSTREAM, start: 0, count: 50}) {
        relationships { entity { urn } }
      }
      downstream: lineage(input: {direction: DOWNSTREAM, start: 0, count: 50}) {
        relationships { entity { urn } }
      }
    }
  }
}`

type lineageResp struct {
	Data struct {
		Entity struct {
			URN      string `json:"urn"`
			Upstream struct {
				Relationships []struct {
					Entity struct {
						URN string `json:"urn"`
					} `json:"entity"`
				} `json:"relationships"`
			} `json:"upstream"`
			Downstream struct {
				Relationships []struct {
					Entity struct {
						URN string `json:"urn"`
					} `json:"entity"`
				} `json:"relationships"`
			} `json:"downstream"`
		} `json:"entity"`
	} `json:"data"`
}

func (c *Client) GetLineage(ctx context.Context, urn string) (adapter.LineageGraph, error) {
	var resp lineageResp
	body := graphQLReq{Query: lineageQuery, Variables: map[string]any{"urn": urn}}
	if err := httpx.Do(ctx, c.http, http.MethodPost, c.baseURL+"/api/graphql", c.headers(), body, &resp); err != nil {
		return adapter.LineageGraph{}, fmt.Errorf("datahub lineage: %w", err)
	}
	g := adapter.LineageGraph{}
	center := resp.Data.Entity.URN
	if center == "" {
		center = urn
	}
	seen := map[string]bool{center: true}
	g.Nodes = append(g.Nodes, adapter.LineageNode{URN: center, Label: datasetNameFromURN(center)})
	add := func(u string) {
		if !seen[u] {
			seen[u] = true
			g.Nodes = append(g.Nodes, adapter.LineageNode{URN: u, Label: datasetNameFromURN(u)})
		}
	}
	for _, r := range resp.Data.Entity.Upstream.Relationships {
		add(r.Entity.URN)
		g.Edges = append(g.Edges, [2]string{r.Entity.URN, center})
	}
	for _, r := range resp.Data.Entity.Downstream.Relationships {
		add(r.Entity.URN)
		g.Edges = append(g.Edges, [2]string{center, r.Entity.URN})
	}
	return g, nil
}

const glossaryQuery = `query g($q: String!) {
  searchAcrossEntities(input: {types: [GLOSSARY_TERM], query: $q, start: 0, count: 500}) {
    searchResults { entity {
      urn
      ... on GlossaryTerm {
        properties { name description customProperties { key value } }
        ownership { owners { owner { ... on CorpUser { username } } } }
      }
    } }
  }
}`

type glossaryResp struct {
	Data struct {
		SearchAcrossEntities struct {
			SearchResults []struct {
				Entity struct {
					URN        string `json:"urn"`
					Properties struct {
						Name             string `json:"name"`
						Description      string `json:"description"`
						CustomProperties []struct {
							Key   string `json:"key"`
							Value string `json:"value"`
						} `json:"customProperties"`
					} `json:"properties"`
					Ownership struct {
						Owners []struct {
							Owner struct {
								Username string `json:"username"`
							} `json:"owner"`
						} `json:"owners"`
					} `json:"ownership"`
				} `json:"entity"`
			} `json:"searchResults"`
		} `json:"searchAcrossEntities"`
	} `json:"data"`
}

const datasetSchemaQuery = `query d($urn: String!) {
  dataset(urn: $urn) {
    schemaMetadata { fields { fieldPath nativeDataType description } }
    editableSchemaMetadata { editableSchemaFieldInfo { fieldPath description } }
  }
}`

type datasetSchemaResp struct {
	Data struct {
		Dataset struct {
			SchemaMetadata struct {
				Fields []struct {
					FieldPath      string `json:"fieldPath"`
					NativeDataType string `json:"nativeDataType"`
					Description    string `json:"description"`
				} `json:"fields"`
			} `json:"schemaMetadata"`
		} `json:"dataset"`
	} `json:"data"`
}

// GetDatasetSchema reads a dataset's columns from its schemaMetadata aspect.
func (c *Client) GetDatasetSchema(ctx context.Context, urn string) ([]adapter.ColumnMeta, error) {
	var resp datasetSchemaResp
	body := graphQLReq{Query: datasetSchemaQuery, Variables: map[string]any{"urn": urn}}
	if err := httpx.Do(ctx, c.http, http.MethodPost, c.baseURL+"/api/graphql", c.headers(), body, &resp); err != nil {
		return nil, fmt.Errorf("datahub dataset schema: %w", err)
	}
	fields := resp.Data.Dataset.SchemaMetadata.Fields
	out := make([]adapter.ColumnMeta, 0, len(fields))
	for _, f := range fields {
		// fieldPath may carry a nested prefix; keep the leaf for display.
		name := f.FieldPath
		if i := strings.LastIndex(name, "."); i >= 0 && i < len(name)-1 {
			name = name[i+1:]
		}
		out = append(out, adapter.ColumnMeta{Name: name, Type: f.NativeDataType, Desc: f.Description})
	}
	return out, nil
}

// ListGlossaryTerms returns business-glossary terms mapped to the metric shape.
func (c *Client) ListGlossaryTerms(ctx context.Context) ([]adapter.GlossaryTerm, error) {
	var resp glossaryResp
	body := graphQLReq{Query: glossaryQuery, Variables: map[string]any{"q": "*"}}
	if err := httpx.Do(ctx, c.http, http.MethodPost, c.baseURL+"/api/graphql", c.headers(), body, &resp); err != nil {
		return nil, fmt.Errorf("datahub glossary: %w", err)
	}
	out := make([]adapter.GlossaryTerm, 0, len(resp.Data.SearchAcrossEntities.SearchResults))
	for _, r := range resp.Data.SearchAcrossEntities.SearchResults {
		e := r.Entity
		props := map[string]string{}
		for _, p := range e.Properties.CustomProperties {
			props[p.Key] = p.Value
		}
		owner := ""
		if len(e.Ownership.Owners) > 0 {
			owner = e.Ownership.Owners[0].Owner.Username
		}
		out = append(out, adapter.GlossaryTerm{
			URN:     e.URN,
			Name:    e.Properties.Name,
			Def:     e.Properties.Description,
			Formula: props["formula"],
			Unit:    props["unit"],
			Owner:   owner,
			Status:  props["status"],
			Source:  props["source_dataset"],
		})
	}
	return out, nil
}

const facetsQuery = `query f($q: String!) {
  searchAcrossEntities(input: {types: [DATASET], query: $q, start: 0, count: 0}) {
    facets { field displayName aggregations { value count } }
  }
}`

type facetsResp struct {
	Data struct {
		SearchAcrossEntities struct {
			Facets []struct {
				Field        string `json:"field"`
				DisplayName  string `json:"displayName"`
				Aggregations []struct {
					Value string `json:"value"`
					Count int    `json:"count"`
				} `json:"aggregations"`
			} `json:"facets"`
		} `json:"searchAcrossEntities"`
	} `json:"data"`
}

// facetTitle maps a DataHub facet field to a friendly front-end group title.
func facetTitle(field, display string) string {
	switch strings.ToLower(field) {
	case "platform", "_entitytype":
		return "Source"
	case "origin", "env":
		return "Source layer"
	case "tags", "glossaryterms":
		return "Sensitivity"
	case "owners":
		return "Owner"
	case "domains":
		return "Domain"
	}
	if display != "" {
		return display
	}
	return field
}

// Facets returns aggregated catalog facets for the search query (empty = all).
func (c *Client) Facets(ctx context.Context, q string) ([]adapter.Facet, error) {
	if q == "" {
		q = "*"
	}
	var resp facetsResp
	body := graphQLReq{Query: facetsQuery, Variables: map[string]any{"q": q}}
	if err := httpx.Do(ctx, c.http, http.MethodPost, c.baseURL+"/api/graphql", c.headers(), body, &resp); err != nil {
		return nil, fmt.Errorf("datahub facets: %w", err)
	}
	out := make([]adapter.Facet, 0, len(resp.Data.SearchAcrossEntities.Facets))
	for _, f := range resp.Data.SearchAcrossEntities.Facets {
		if len(f.Aggregations) == 0 {
			continue
		}
		facet := adapter.Facet{Title: facetTitle(f.Field, f.DisplayName)}
		for _, a := range f.Aggregations {
			label := a.Value
			if i := strings.LastIndex(label, ":"); i >= 0 && i < len(label)-1 {
				label = label[i+1:] // trim urn/term prefixes to a readable label
			}
			facet.Options = append(facet.Options, adapter.FacetOption{Label: label, Count: a.Count})
		}
		out = append(out, facet)
	}
	return out, nil
}

// mcp is a rest.li MetadataChangeProposal for ingestProposal.
type mcp struct {
	Proposal struct {
		EntityType string `json:"entityType"`
		EntityURN  string `json:"entityUrn"`
		ChangeType string `json:"changeType"`
		AspectName string `json:"aspectName"`
		Aspect     struct {
			Value       string `json:"value"`
			ContentType string `json:"contentType"`
		} `json:"aspect"`
	} `json:"proposal"`
}

// UpsertStatus records pipeline/run status onto a dataset URN via the GMS
// ingestProposal API (a custom "status" structured aspect carried as JSON).
func (c *Client) UpsertStatus(ctx context.Context, urn string, status any) error {
	valueJSON, err := toJSONString(status)
	if err != nil {
		return err
	}
	var m mcp
	m.Proposal.EntityType = "dataset"
	m.Proposal.EntityURN = urn
	m.Proposal.ChangeType = "UPSERT"
	m.Proposal.AspectName = "status"
	m.Proposal.Aspect.Value = valueJSON
	m.Proposal.Aspect.ContentType = "application/json"
	if err := httpx.Do(ctx, c.http, http.MethodPost, c.baseURL+"/aspects?action=ingestProposal", c.headers(), m, nil); err != nil {
		return fmt.Errorf("datahub upsert status: %w", err)
	}
	return nil
}

// inQMSDomain keeps only datasets in the IPAS QMS namespaces (Iceberg
// bronze/silver/gold_qms, ClickHouse qms_gold, PG qms_warehouse) and filters out
// unrelated tables on the shared engines. Adjust if more business domains are
// onboarded (or promote to config).
func inQMSDomain(urn string) bool {
	return strings.Contains(strings.ToLower(urn), "qms")
}

func layerFor(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "gold"):
		return "Gold"
	case strings.Contains(n, "silver"):
		return "Silver"
	case strings.Contains(n, "bronze"):
		return "Bronze"
	default:
		return "RAW"
	}
}

func sensFromTerms(terms []struct {
	Term struct {
		URN string `json:"urn"`
	} `json:"term"`
}) string {
	for _, t := range terms {
		u := strings.ToLower(t.Term.URN)
		switch {
		case strings.Contains(u, "pii"):
			return "PII"
		case strings.Contains(u, "confidential"):
			return "Confidential"
		case strings.Contains(u, "public"):
			return "Public"
		}
	}
	return "Internal"
}

// datasetNameFromURN extracts the table name from urn:li:dataset:(platform,name,env).
func datasetNameFromURN(urn string) string {
	if urn == "" {
		return ""
	}
	start := strings.Index(urn, ",")
	end := strings.LastIndex(urn, ",")
	if start >= 0 && end > start {
		full := urn[start+1 : end]
		parts := strings.Split(full, ".")
		return parts[len(parts)-1]
	}
	return urn
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func toJSONString(v any) (string, error) {
	if s, ok := v.(string); ok {
		return s, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("marshal status: %w", err)
	}
	return string(b), nil
}
