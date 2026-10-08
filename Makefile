.PHONY: demo demo-prepare demo-check demo-import-enrollment

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

# One-time recovery for an older prepared deployment; never redeploys or overwrites.
demo-import-enrollment:
	@test -n "$(DEMO_CONFIG)" || (echo 'Set DEMO_CONFIG=/absolute/path/config.json'; exit 1)
	pnpm --filter @pathnod/verifier demo -- --config "$(DEMO_CONFIG)" --import-enrollment
