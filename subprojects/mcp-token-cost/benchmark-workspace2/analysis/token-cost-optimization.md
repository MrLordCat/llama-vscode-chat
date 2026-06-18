# Phase 6: Token-Cost Optimization

## Current Token Usage Patterns

### Tool Definition Token Cost
- **Full Mode**: All VS Code tools (15-20 tools) with full schema descriptions
- **apiDirect Mode**: Prioritized subset (4-8 tools) with compacted schemas
- **Estimated Savings**: 60-70% reduction in tool definition tokens

### Schema Compaction Strategy
```typescript
// Drops metadata keys that don't affect execution:
const drop = new Set([
    "description", "default", "format", 
    "pattern", "minLength", "maxLength"
]);
```

### Description Normalization
- Truncate descriptions to 140 characters
- First sentence extraction
- Whitespace normalization

## Optimization Options

### Option A: Enhanced Schema Compaction
**Approach**: Further reduce schema verbosity
- Remove optional parameter descriptions
- Simplify nested object structures
- Use shorthand types where possible

**Estimated Savings**: Additional 20-30% on tool tokens
**Risk**: Low - schema still valid, just less descriptive

### Option B: Dynamic Tool Loading
**Approach**: Only advertise tools relevant to current task context
- Analyze user query for tool hints
- Load matching tools on-demand
- Cache frequently used tool definitions

**Estimated Savings**: 40-50% on tool tokens
**Risk**: Medium - requires query analysis, may miss edge cases

### Option C: Tool Caching with LRU
**Approach**: Cache compiled tool definitions
- Hash tool configurations
- Reuse compiled definitions across turns
- Evict least-recently-used entries

**Estimated Savings**: Reduced serialization overhead
**Risk**: Low - pure performance optimization

## Recommendation
**Choose Option A: Enhanced Schema Compaction**
- Low risk, high impact
- Already implemented foundation in `compactApiDirectSchema`
- Can extend to drop more metadata fields
- Maintains backward compatibility

## Implementation Plan
1. Extend `drop` set in `compactApiDirectSchema`
2. Add additional compaction for nested objects
3. Measure token reduction via benchmark
4. Validate test suite still passes
