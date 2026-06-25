// Package k8s is the cluster-ops adapter (ARCHITECTURE.md §8/§9) built on
// client-go. It applies NetworkPolicies (§9 lockdown) and reads pod status for
// the Ops pages. Uses the in-cluster config when running as a Pod, else falls
// back to the local kubeconfig (works behind Telepresence).
package k8s

import (
	"context"
	"fmt"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"

	"path/filepath"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

type Client struct {
	cs *kubernetes.Clientset
}

// New builds the client. It tries in-cluster config first, then ~/.kube/config.
func New() (*Client, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		kubeconfig := filepath.Join(homedir.HomeDir(), ".kube", "config")
		cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("k8s config (in-cluster and kubeconfig failed): %w", err)
		}
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("k8s clientset: %w", err)
	}
	return &Client{cs: cs}, nil
}

// ApplyNetworkPolicy creates-or-updates a default-deny + allow-control-plane
// ingress policy (the §9 lockdown shape) for the given target.
func (c *Client) ApplyNetworkPolicy(ctx context.Context, spec adapter.NetworkPolicySpec) error {
	np := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: spec.Name, Namespace: spec.Namespace},
		Spec: networkingv1.NetworkPolicySpec{
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From: []networkingv1.NetworkPolicyPeer{{
					NamespaceSelector: &metav1.LabelSelector{
						MatchLabels: map[string]string{"kubernetes.io/metadata.name": "control-plane"},
					},
				}},
			}},
		},
	}
	api := c.cs.NetworkingV1().NetworkPolicies(spec.Namespace)
	if _, err := api.Create(ctx, np, metav1.CreateOptions{}); err != nil {
		// Already exists -> update.
		if _, uerr := api.Update(ctx, np, metav1.UpdateOptions{}); uerr != nil {
			return fmt.Errorf("apply networkpolicy: create=%v update=%w", err, uerr)
		}
	}
	return nil
}

// PodStatus lists pods in a namespace matching labelSelector.
func (c *Client) PodStatus(ctx context.Context, ns, labelSelector string) ([]adapter.PodStatus, error) {
	pods, err := c.cs.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: labelSelector})
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	out := make([]adapter.PodStatus, 0, len(pods.Items))
	for _, p := range pods.Items {
		out = append(out, adapter.PodStatus{Name: p.Name, Phase: string(p.Status.Phase)})
	}
	return out, nil
}
