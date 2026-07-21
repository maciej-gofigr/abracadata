# Backend (FastAPI) convenience targets.
# Override on the command line, e.g. `make dev-local PORT=8001`.

# Fallback AWS SSO profile, used only when .env provides no IAM access key.
AWS_PROFILE ?= AdministratorAccess-287127677421
AWS_REGION  ?= us-east-2
PORT        ?= 8000
PYTHON      := ./.venv/bin/python

.DEFAULT_GOAL := help

.PHONY: help dev-local

help: ## Show available targets
	@echo "Backend targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

dev-local: ## Run the API locally: sqlite, Bedrock via backend/.env (or host SSO), dev auth codes, --reload
	set -a; [ -f .env ] && . ./.env; set +a; \
	[ -n "$$AWS_ACCESS_KEY_ID" ] || export AWS_PROFILE=$${AWS_PROFILE:-$(AWS_PROFILE)}; \
	export AWS_REGION=$${AWS_REGION:-$(AWS_REGION)}; \
	AUTH_DEV_ECHO=1 $(PYTHON) -m uvicorn app.main:app --reload --port $(PORT)
