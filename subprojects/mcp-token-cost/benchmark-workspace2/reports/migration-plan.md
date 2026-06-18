# Phase 7: API-Direct Migration Plan

## Executive Summary
Migrate from full VS Code tool catalog (`classic` mode) to prioritized tool subset (`apiDirect` mode) to reduce token overhead and improve response times.

## Migration Phases

### Phase 1: Foundation (Week 1-2)
**Objectives**:
- [x] Implement `ToolCallingMode` type
- [x] Add `apiDirectMaxTools` setting
- [x] Add `apiDirectIncludeAllTools` setting
- [x] Build tool prioritization system
- [x] Create schema compaction logic

**KPIs**:
- Token reduction: 60-70% on tool definitions
- Test coverage: 100% (all 30 tests passing)

### Phase 2: Validation (Week 3-4)
**Objectives**:
- [ ] Benchmark apiDirect vs classic TPS
- [ ] Measure response time improvement
- [ ] Test with various model sizes (8B, 27B, 70B)
- [ ] Validate tool execution accuracy

**KPIs**:
- TPS improvement: ≥15%
- Tool success rate: ≥95%
- User satisfaction: ≥4.0/5.0

### Phase 3: Rollout (Week 5-6)
**Objectives**:
- [ ] Add UI toggle for tool calling mode
- [ ] Create mode recommendation system
- [ ] Document migration guide
- [ ] Publish extension update

**KPIs**:
- Adoption rate: ≥30% within first month
- Support tickets: <5% increase

### Phase 4: Optimization (Week 7-8)
**Objectives**:
- [ ] Implement dynamic tool loading
- [ ] Add tool caching layer
- [ ] Optimize schema serialization
- [ ] Performance profiling

**KPIs**:
- Additional token savings: 20-30%
- Memory reduction: ≥10%

## Rollback Strategy
- Keep `classic` mode as fallback
- Feature flag for mode switching
- Automated test validation on each release
- User feedback monitoring

## Risk Assessment
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tool execution failures | Low | High | Comprehensive testing |
| Performance regression | Medium | Medium | Benchmark validation |
| User confusion | Medium | Low | Clear documentation |
| Model compatibility | Low | Medium | Multi-model testing |

## Success Metrics
- **Primary**: Token reduction ≥60%
- **Secondary**: TPS improvement ≥15%
- **Tertiary**: User adoption ≥30%
