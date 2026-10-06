package main

import (
	"fmt"
	"github.com/Yelqo/paperclip-outpost/internal/outpost"
	"os"
)

func main() {
	if err := outpost.Run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		// All errors crossing this boundary are fixed diagnostic messages.
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
