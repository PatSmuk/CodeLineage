package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// FunctionCallMap represents a mapping of function names to functions they call
type FunctionCallMap map[string][]string

// BuildFunctionCallMap constructs a map of function calls for a given directory
func BuildFunctionCallMap(directory string) (FunctionCallMap, error) {
	callMap := make(FunctionCallMap)
	fileSet := token.NewFileSet()

	// Walk through all Go files in the directory
	err := filepath.Walk(directory, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
			file, err := parser.ParseFile(fileSet, path, nil, parser.AllErrors)
			if err != nil {
				return err
			}

			analyzeFunctionCalls(file, callMap)
		}
		return nil
	})

	if err != nil {
		return nil, err
	}

	return callMap, nil
}

// analyzeFunctionCalls extracts function calls and builds the map
func analyzeFunctionCalls(file *ast.File, callMap FunctionCallMap) {
	// Track function declarations in this file
	funcDecls := make(map[string]bool)

	// First pass: collect all function names
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok {
			// Handle method and function declarations
			var funcName string
			if fn.Recv != nil {
				// Method declaration
				methodName := fn.Name.Name
				var receiverType string
				if recv, ok := fn.Recv.List[0].Type.(*ast.Ident); ok {
					receiverType = recv.Name
				}
				funcName = fmt.Sprintf("%s.%s", receiverType, methodName)
			} else {
				// Function declaration
				funcName = fn.Name.Name
			}
			funcDecls[funcName] = true
		}
	}

	// Second pass: analyze function calls
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok {
			// Determine current function name
			var currentFuncName string
			if fn.Recv != nil {
				// Method declaration
				methodName := fn.Name.Name
				var receiverType string
				if recv, ok := fn.Recv.List[0].Type.(*ast.Ident); ok {
					receiverType = recv.Name
				}
				currentFuncName = fmt.Sprintf("%s.%s", receiverType, methodName)
			} else {
				// Function declaration
				currentFuncName = fn.Name.Name
			}

			// Initialize the entry if not exists
			if _, exists := callMap[currentFuncName]; !exists {
				callMap[currentFuncName] = []string{}
			}

			// Inspect the function body for calls
			ast.Inspect(fn, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok {
					var calledFuncName string

					// Handle different types of function calls
					switch fun := call.Fun.(type) {
					case *ast.Ident:
						// Direct function call
						calledFuncName = fun.Name
					case *ast.SelectorExpr:
						// Method call or package function call
						if id, ok := fun.X.(*ast.Ident); ok {
							calledFuncName = fmt.Sprintf("%s.%s", id.Name, fun.Sel.Name)
						}
					}

					// Only add if it's a declared function and not already in the list
					if funcDecls[calledFuncName] {
						// Avoid duplicate entries
						exists := false
						for _, existing := range callMap[currentFuncName] {
							if existing == calledFuncName {
								exists = true
								break
							}
						}
						if !exists {
							callMap[currentFuncName] = append(callMap[currentFuncName], calledFuncName)
						}
					}
				}
				return true
			})
		}
	}
}

// PrintFunctionCallMap displays the function call map
func PrintFunctionCallMap(callMap FunctionCallMap) {
	for funcName, calls := range callMap {
		fmt.Printf("%s calls:\n", funcName)
		for _, call := range calls {
			fmt.Printf("  - %s\n", call)
		}
	}
}

func main() {
	if len(os.Args) < 2 {
		log.Fatal("Please provide a directory path as an argument")
	}

	directory := os.Args[1]
	functionCallMap, err := BuildFunctionCallMap(directory)
	if err != nil {
		log.Fatalf("Error building function call map: %v", err)
	}

	PrintFunctionCallMap(functionCallMap)
}
