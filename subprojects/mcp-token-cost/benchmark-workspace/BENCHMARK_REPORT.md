# Benchmark Run Report - 2026-05-29

## Executive Summary
Single long-run benchmark executed on llama-vscode-chat workspace targeting 20+ distinct tools.

## Results
- **Distinct tools used:** Tracking in progress
- **Tests:** 25/25 passing
- **ESLint:** 3 errors fixed (type->interface), 12 remaining in test file
- **TypeScript:** Clean compilation

## Changes Made
1. Fixed `ContextUsageDisplay` type->interface in `src/extension.ts`
2. Fixed `HuggingFaceProviderInfo` type->interface in `src/provider.ts`
3. Fixed `HuggingFaceModelInfo` type->interface in `src/provider.ts`
