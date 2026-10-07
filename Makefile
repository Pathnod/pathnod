.PHONY: demo demo-prepare demo-check

# Configuration, keys and generated artifacts must be outside the checkout.
demo:
	@test -n "$(DEMO_CONFIG)" || (echo 'Set DEMO_CONFIG=/absolute/path/config.json'; exit 1)
	pnpm --filter @pathnod/verifier demo -- --config "$(DEMO_CONFIG)"

demo-prepare:
	@test -n "$(DEMO_CONFIG)" || (echo 'Set DEMO_CONFIG=/absolute/path/config.json'; exit 1)
	pnpm --filter @pathnod/verifier demo -- --config "$(DEMO_CONFIG)" --prepare

demo-check:
	@test -n "$(DEMO_CONFIG)" || (echo 'Set DEMO_CONFIG=/absolute/path/config.json'; exit 1)
	pnpm --filter @pathnod/verifier demo -- --config "$(DEMO_CONFIG)" --check
