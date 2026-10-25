# exo-agent-stack. Written for GNU Make 3.81 (the macOS default), so it avoids newer make features.
SHELL := /bin/bash
.DEFAULT_GOAL := help

PNPM ?= pnpm
COMPOSE ?= docker compose
# Claude Code on the web needs host-network builds (Appendix A); classic builder, no bake.
ifeq ($(CLAUDE_CODE_REMOTE),true)
COMPOSE := docker compose -f compose.yaml -f compose.cloud.yaml
export COMPOSE_BAKE := false
endif

# Containers run as the invoking user so the bind-mounted state directory stays writable on Linux.
export EXOS_UID ?= $(shell id -u)
export EXOS_GID ?= $(shell id -g)

# Targets whose task is not built yet fail loudly instead of pretending to pass.
define NOT_YET
	@echo "make $@ is not implemented yet (BUILD.md task $(1))" >&2; exit 1
endef

.PHONY: help
help: ## List targets
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | sort

# --- Lifecycle ----------------------------------------------------------------------------------

.PHONY: bootstrap
bootstrap: ## Install toolchains and dependencies, create .env from .env.example
	scripts/install-tools.sh
	$(PNPM) install --frozen-lockfile
	uv sync
	@[ -f .env ] || { cp .env.example .env && echo "created .env from .env.example"; }

.PHONY: up
up: ## Start the full stack in Docker Compose with healthchecks
	mkdir -p .exos-state/compose
	$(COMPOSE) up -d --build --wait

.PHONY: down
down: ## Stop the stack
	$(COMPOSE) down --remove-orphans

.PHONY: seed
seed: ## Write the synthetic datasets and fixtures (seed 20261022, gen.v1)
	$(PNPM) exec tsx data/generator/src/cli.ts

.PHONY: demo
demo: ## Run the scripted demo scenario against the running stack, offline
	$(PNPM) exec tsx scripts/demo.ts

.PHONY: logs
logs: ## Follow the logs of every service
	$(COMPOSE) logs -f

.PHONY: clean
clean: ## Remove containers, volumes, caches and build outputs
	@if [ -f compose.yaml ]; then $(COMPOSE) down -v --remove-orphans; fi
	rm -rf coverage playwright-report test-results .vitest-cache
	find . -name dist -type d -prune -not -path './node_modules/*' -not -path './vendor/*' -exec rm -rf {} +

# --- Quality gates ------------------------------------------------------------------------------

.PHONY: lint
lint: ## eslint, prettier, markdownlint, hadolint, actionlint
	$(PNPM) exec prettier --check .
	$(PNPM) exec eslint .
	$(PNPM) exec markdownlint-cli2
	@if [ -d .github/workflows ]; then actionlint; else echo "actionlint: no workflows yet"; fi
	@if [ -d docker ]; then hadolint docker/*.Dockerfile; else echo "hadolint: no Dockerfiles yet"; fi

.PHONY: typecheck
typecheck: ## tsc --noEmit, strict
	$(PNPM) exec tsc --noEmit -p tsconfig.json

.PHONY: security
security: ## gitleaks, audits, trivy, licences, policy-guardian rules
	$(call NOT_YET,T-46)

.PHONY: check-fast
check-fast: lint test-unit ## Lint and unit tests, under 60 seconds

.PHONY: test-unit
test-unit:
	$(PNPM) exec vitest run --project unit

.PHONY: test
test: test-unit ## Unit, integration and contract tests on the host
	$(PNPM) exec vitest run --project integration --project contract --passWithNoTests

.PHONY: test-docker
test-docker: ## The full test suite inside containers
	$(call NOT_YET,T-47)

.PHONY: e2e
e2e: ## Playwright end-to-end tests against the running stack
	$(call NOT_YET,T-38)

.PHONY: bench
bench: ## Performance tests with budgets
	$(call NOT_YET,T-45)

.PHONY: verify
verify: lint typecheck security test eval bench doctor ## Everything except eval-live; the single gate

.PHONY: verify-clean
verify-clean: ## make verify in a fresh clone in a temporary folder
	$(call NOT_YET,T-52)

.PHONY: docs
docs: ## Regenerate diagrams, OpenAPI, frontend types and screenshots
	$(call NOT_YET,T-49)

# --- Evals --------------------------------------------------------------------------------------

.PHONY: eval
eval: ## Offline evals with thresholds, writes evals/REPORT.md
	$(call NOT_YET,T-39)

.PHONY: eval-live
eval-live: ## Live evals on subscriptions within LIVE_EVAL_BUDGET_USD (maintainer only)
	$(call NOT_YET,T-44)

.PHONY: eval-durability
eval-durability: ## Durability suite
	$(call NOT_YET,T-40)

.PHONY: eval-delegation
eval-delegation: ## Delegation suite
	$(call NOT_YET,T-41)

.PHONY: eval-policy
eval-policy: ## Policy suite
	$(call NOT_YET,T-42)

.PHONY: eval-credit
eval-credit: ## Credit suite
	$(call NOT_YET,T-43)

# --- Exo, agents and host run -------------------------------------------------------------------

.PHONY: exo-build
exo-build: ## Build the pinned Exo (pnpm install + cargo build -p exo --release)
	$(call NOT_YET,T-02)

.PHONY: exo-doctor
exo-doctor: ## exo agent doctor per agent
	$(call NOT_YET,T-09)

.PHONY: doctor
doctor: ## exos doctor --json, exit 1 on any fail
	$(call NOT_YET,T-31)

.PHONY: agents-lint
agents-lint: ## Lint agent definitions (hand-written and generated)
	$(PNPM) exec tsx cli/src/main.ts agents lint agents
	@if [ -d agents/generated ]; then $(PNPM) exec tsx cli/src/main.ts agents lint agents/generated; fi

.PHONY: agents-render
agents-render: ## Render generated agent definitions
	$(PNPM) exec tsx scripts/agents-render.ts

.PHONY: agents-sync
agents-sync: ## Sync agent definitions into Exo
	$(PNPM) exec tsx cli/src/main.ts agents sync

.PHONY: host-up
host-up: ## Native Exo, stackd and bridge
	$(call NOT_YET,T-33)

.PHONY: host-down
host-down: ## Stop the native stack
	$(call NOT_YET,T-33)

.PHONY: record-exo-fixtures
record-exo-fixtures: ## Host-only: re-record WireMock mappings from a real Exo
	$(call NOT_YET,T-08)

.PHONY: test-exo
test-exo: ## Host-only: real-Exo tests
	$(call NOT_YET,T-08)

.PHONY: plugin-validate
plugin-validate: ## Validate the Claude Code plugin
	$(call NOT_YET,T-32)

.PHONY: live-claude
live-claude: ## Maintainer-only guarded smoke turn on the Claude subscription
	$(call NOT_YET,T-44)

.PHONY: live-cursor
live-cursor: ## Maintainer-only guarded smoke turn on the Cursor subscription
	$(call NOT_YET,T-44)
