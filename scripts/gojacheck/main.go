// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Package main checks plugin syntax with the server's Goja runtime
package main

import (
	"fmt"
	"os"

	"github.com/dop251/goja"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: gojacheck <file.js> [...]")
		os.Exit(2)
	}
	failed := false
	for _, path := range os.Args[1:] {
		src, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %s: %v\n", path, err)
			failed = true
			continue
		}
		if _, err := goja.Compile(path, string(src), false); err != nil {
			fmt.Fprintf(os.Stderr, "error: %s: %v\n", path, err)
			failed = true
			continue
		}
		fmt.Printf("ok: %s\n", path)
	}
	if failed {
		os.Exit(1)
	}
}
