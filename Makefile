.PHONY: demo demo-prepare demo-check demo-import-enrollment gate2-check gate2-status gate2-replay gate2-report confidence-import confidence-compute confidence-publish confidence-status confidence-report linked-asset-prepare linked-asset-mint linked-asset-register linked-asset-report

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

gate2-check gate2-status gate2-replay gate2-report:
	@test -n "$(GATE2_CONFIG)" || (echo 'Set GATE2_CONFIG=/absolute/private/gate2.json'; exit 1)
	pnpm --filter @pathnod/verifier gate2 -- --config "$(GATE2_CONFIG)" $(patsubst gate2-%,%,$@)

confidence-import confidence-compute confidence-publish confidence-status confidence-report:
	@test -n "$(CONFIDENCE_CONFIG)" || (echo 'Set CONFIDENCE_CONFIG=/absolute/private/confidence.json'; exit 1)
	pnpm --filter @pathnod/verifier confidence -- --config "$(CONFIDENCE_CONFIG)" $(patsubst confidence-%,%,$@)

linked-asset-prepare linked-asset-mint linked-asset-register linked-asset-report:
	@test -n "$(LINKED_ASSET_CONFIG)" || (echo 'Set LINKED_ASSET_CONFIG=/absolute/private/linked-asset.json'; exit 1)
	pnpm --filter @pathnod/solana assets:demo -- --config "$(LINKED_ASSET_CONFIG)" $(patsubst linked-asset-%,%,$@)
