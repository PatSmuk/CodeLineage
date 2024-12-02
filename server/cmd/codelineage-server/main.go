package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type Request struct {
	Type     string `json:"type"`
	FileName string `json:"fileName,omitempty"`
}

type CodeAnalysis struct {
	Functions []FunctionAnalysis `json:"functions"`
}

type FunctionAnalysis struct {
	FuncName string    `json:"funcName"`
	Struct   string    `json:"struct"`
	Lineages []Lineage `json:"lineages"`
}

type Lineage struct {
	Lineage string `json:"lineage"`
	Link    Link   `json:"link"`
}

type Link struct {
	FileName string `json:"fileName"`
	Line     int    `json:"line"`
}

func main() {
	// Receive JSON from stdin
	decoder := json.NewDecoder(os.Stdin)
	for {
		var request Request
		if err := decoder.Decode(&request); err != nil {
			// Handle error
			fmt.Printf("%s", err.Error())
			os.Exit(1)
		}

		// Process message...

		// Send response via stdout
		encoder := json.NewEncoder(os.Stdout)
		response := CodeAnalysis{
			Functions: []FunctionAnalysis{
				{
					FuncName: "recordVersionMetric",
					Lineages: []Lineage{
						{
							Lineage: "8",
							Link: Link{
								FileName: "cmd/impression/impression.go",
								Line:     72,
							},
						},
					},
				},
			},
		}
		if err := encoder.Encode(response); err != nil {
			// Handle error
			fmt.Printf("%s", err.Error())
			os.Exit(1)
		}
	}
}
