TypeScript=tsc

mima.js: 
	$(TypeScript) mima.ts

.PHONY: mima.js
