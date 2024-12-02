package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type RequestMessage struct {
	RequestID int32       `json:"requestId"`
	Type      string      `json:"type"`
	Data      interface{} `json:"data"`
}

type TagsResponseMessage struct {
	RequestID int32  `json:"requestId"`
	TODO      string `json:"todo"`
}

func main() {
	// Receive JSON from stdin
	decoder := json.NewDecoder(os.Stdin)
	for {
		var requestMsg RequestMessage
		if err := decoder.Decode(&requestMsg); err != nil {
			// Handle error
			fmt.Printf("%s", err.Error())
			os.Exit(1)
		}

		// Process message...

		// Send response via stdout
		encoder := json.NewEncoder(os.Stdout)
		responseMsg := TagsResponseMessage{
			RequestID: requestMsg.RequestID,
			TODO:      "",
		}
		if err := encoder.Encode(responseMsg); err != nil {
			// Handle error
			fmt.Printf("%s", err.Error())
			os.Exit(1)
		}
	}
}
