Explain why this Go code may print fewer than 100 lines and fix it:
for i := 0; i < 100; i++ { go func() { fmt.Println(i) }() }
