# Frontend (Vite SPA) convenience targets.
# Backend targets live in ../backend/Makefile.

.DEFAULT_GOAL := help

.PHONY: help dev-local

help: ## Show available targets
	@echo "Frontend targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

dev-local: ## Run the Vite dev server (http://localhost:5173, proxies /api -> :8000)
	npm run dev
