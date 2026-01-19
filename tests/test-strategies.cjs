/**
 * Test Account Selection Strategies - Unit Tests
 *
 * Tests the strategy pattern implementation for account selection:
 * - HealthTracker: health score tracking with passive recovery
 * - TokenBucketTracker: token bucket rate limiting
 * - StickyStrategy: cache-optimized sticky selection
 * - RoundRobinStrategy: load-balanced rotation
 * - HybridStrategy: smart multi-signal distribution
 * - Strategy Factory: createStrategy, isValidStrategy, getStrategyLabel
 */

// Since we're in CommonJS and the module is ESM, we need to use dynamic import
async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           ACCOUNT SELECTION STRATEGY TEST SUITE              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic imports for ESM modules
    const { HealthTracker } = await import('../src/account-manager/strategies/trackers/health-tracker.js');
    const { TokenBucketTracker } = await import('../src/account-manager/strategies/trackers/token-bucket-tracker.js');
    const { StickyStrategy } = await import('../src/account-manager/strategies/sticky-strategy.js');
    const { RoundRobinStrategy } = await import('../src/account-manager/strategies/round-robin-strategy.js');
    const { HybridStrategy } = await import('../src/account-manager/strategies/hybrid-strategy.js');
    const { BaseStrategy } = await import('../src/account-manager/strategies/base-strategy.js');
    const {
        createStrategy,
        isValidStrategy,
        getStrategyLabel,
        STRATEGY_NAMES,
        DEFAULT_STRATEGY
    } = await import('../src/account-manager/strategies/index.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
        }
    }

    function assertDeepEqual(actual, expected, message = '') {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`${message}\nExpected: ${JSON.stringify(expected, null, 2)}\nActual: ${JSON.stringify(actual, null, 2)}`);
        }
    }

    function assertTrue(value, message = '') {
        if (!value) {
            throw new Error(message || 'Expected true but got false');
        }
    }

    function assertFalse(value, message = '') {
        if (value) {
            throw new Error(message || 'Expected false but got true');
        }
    }

    function assertNull(value, message = '') {
        if (value !== null) {
            throw new Error(`${message}\nExpected null but got: ${value}`);
        }
    }

    function assertWithin(actual, min, max, message = '') {
        if (actual < min || actual > max) {
            throw new Error(`${message}\nExpected value between ${min} and ${max}, got: ${actual}`);
        }
    }

    // Helper to create mock accounts
    function createMockAccounts(count = 3, options = {}) {
        return Array.from({ length: count }, (_, i) => ({
            email: `account${i + 1}@example.com`,
            enabled: true,
            isInvalid: false,
            lastUsed: Date.now() - (i * 60000), // Stagger by 1 minute
            modelRateLimits: {},
            ...options
        }));
    }

    // ==========================================================================
    // HEALTH TRACKER TESTS
    // ==========================================================================
    console.log('\n─── HealthTracker Tests ───');

    test('HealthTracker: initial score is 70 by default', () => {
        const tracker = new HealthTracker();
        const score = tracker.getScore('new@example.com');
        assertEqual(score, 70, 'Default initial score should be 70');
    });

    test('HealthTracker: custom initial score', () => {
        const tracker = new HealthTracker({ initial: 80 });
        const score = tracker.getScore('new@example.com');
        assertEqual(score, 80, 'Custom initial score should be 80');
    });

    test('HealthTracker: recordSuccess increases score', () => {
        const tracker = new HealthTracker({ initial: 70, successReward: 1 });
        tracker.recordSuccess('test@example.com');
        const score = tracker.getScore('test@example.com');
        assertEqual(score, 71, 'Score should increase by 1 on success');
    });

    test('HealthTracker: recordRateLimit decreases score', () => {
        const tracker = new HealthTracker({ initial: 70, rateLimitPenalty: -10 });
        tracker.recordRateLimit('test@example.com');
        const score = tracker.getScore('test@example.com');
        assertEqual(score, 60, 'Score should decrease by 10 on rate limit');
    });

    test('HealthTracker: recordFailure decreases score', () => {
        const tracker = new HealthTracker({ initial: 70, failurePenalty: -20 });
        tracker.recordFailure('test@example.com');
        const score = tracker.getScore('test@example.com');
        assertEqual(score, 50, 'Score should decrease by 20 on failure');
    });

    test('HealthTracker: score cannot exceed maxScore', () => {
        const tracker = new HealthTracker({ initial: 99, maxScore: 100, successReward: 5 });
        tracker.recordSuccess('test@example.com');
        const score = tracker.getScore('test@example.com');
        assertEqual(score, 100, 'Score should be capped at maxScore');
    });

    test('HealthTracker: score cannot go below 0', () => {
        const tracker = new HealthTracker({ initial: 10, failurePenalty: -50 });
        tracker.recordFailure('test@example.com');
        const score = tracker.getScore('test@example.com');
        assertEqual(score, 0, 'Score should not go below 0');
    });

    test('HealthTracker: isUsable returns true when score >= minUsable', () => {
        const tracker = new HealthTracker({ initial: 50, minUsable: 50 });
        assertTrue(tracker.isUsable('test@example.com'), 'Should be usable at minUsable');
    });

    test('HealthTracker: isUsable returns false when score < minUsable', () => {
        const tracker = new HealthTracker({ initial: 49, minUsable: 50 });
        assertFalse(tracker.isUsable('test@example.com'), 'Should not be usable below minUsable');
    });

    test('HealthTracker: reset restores initial score', () => {
        const tracker = new HealthTracker({ initial: 70 });
        tracker.recordFailure('test@example.com'); // Score drops
        tracker.reset('test@example.com');
        const score = tracker.getScore('test@example.com');
        assertEqual(score, 70, 'Reset should restore initial score');
    });

    test('HealthTracker: clear removes all scores', () => {
        const tracker = new HealthTracker({ initial: 70 });
        tracker.recordSuccess('a@example.com');
        tracker.recordSuccess('b@example.com');
        tracker.clear();
        // After clear, new accounts should get initial score
        assertEqual(tracker.getScore('a@example.com'), 70);
        assertEqual(tracker.getScore('b@example.com'), 70);
    });

    test('HealthTracker: getConsecutiveFailures returns 0 for new account', () => {
        const tracker = new HealthTracker();
        assertEqual(tracker.getConsecutiveFailures('new@example.com'), 0);
    });

    test('HealthTracker: recordRateLimit increments consecutiveFailures', () => {
        const tracker = new HealthTracker();
        tracker.recordRateLimit('test@example.com');
        assertEqual(tracker.getConsecutiveFailures('test@example.com'), 1);
        tracker.recordRateLimit('test@example.com');
        assertEqual(tracker.getConsecutiveFailures('test@example.com'), 2);
    });

    test('HealthTracker: recordFailure increments consecutiveFailures', () => {
        const tracker = new HealthTracker();
        tracker.recordFailure('test@example.com');
        assertEqual(tracker.getConsecutiveFailures('test@example.com'), 1);
    });

    test('HealthTracker: recordSuccess resets consecutiveFailures', () => {
        const tracker = new HealthTracker();
        tracker.recordRateLimit('test@example.com');
        tracker.recordRateLimit('test@example.com');
        assertEqual(tracker.getConsecutiveFailures('test@example.com'), 2);
        tracker.recordSuccess('test@example.com');
        assertEqual(tracker.getConsecutiveFailures('test@example.com'), 0);
    });

    test('HealthTracker: reset clears consecutiveFailures', () => {
        const tracker = new HealthTracker();
        tracker.recordFailure('test@example.com');
        tracker.recordFailure('test@example.com');
        assertEqual(tracker.getConsecutiveFailures('test@example.com'), 2);
        tracker.reset('test@example.com');
        assertEqual(tracker.getConsecutiveFailures('test@example.com'), 0);
    });

    // ==========================================================================
    // TOKEN BUCKET TRACKER TESTS
    // ==========================================================================
    console.log('\n─── TokenBucketTracker Tests ───');

    test('TokenBucketTracker: initial tokens is 50 by default', () => {
        const tracker = new TokenBucketTracker();
        const tokens = tracker.getTokens('new@example.com');
        assertEqual(tokens, 50, 'Default initial tokens should be 50');
    });

    test('TokenBucketTracker: custom initial tokens', () => {
        const tracker = new TokenBucketTracker({ initialTokens: 30 });
        const tokens = tracker.getTokens('new@example.com');
        assertEqual(tokens, 30, 'Custom initial tokens should be 30');
    });

    test('TokenBucketTracker: consume decreases tokens', () => {
        const tracker = new TokenBucketTracker({ initialTokens: 10, maxTokens: 10 });
        const consumed = tracker.consume('test@example.com');
        assertTrue(consumed, 'Consume should return true');
        assertEqual(tracker.getTokens('test@example.com'), 9, 'Tokens should decrease by 1');
    });

    test('TokenBucketTracker: consume fails when no tokens', () => {
        const tracker = new TokenBucketTracker({ initialTokens: 0, maxTokens: 10 });
        const consumed = tracker.consume('test@example.com');
        assertFalse(consumed, 'Consume should return false when no tokens');
    });

    test('TokenBucketTracker: hasTokens returns true when tokens > 0', () => {
        const tracker = new TokenBucketTracker({ initialTokens: 1 });
        assertTrue(tracker.hasTokens('test@example.com'), 'Should have tokens');
    });

    test('TokenBucketTracker: hasTokens returns false when tokens < 1', () => {
        const tracker = new TokenBucketTracker({ initialTokens: 0 });
        assertFalse(tracker.hasTokens('test@example.com'), 'Should not have tokens');
    });

    test('TokenBucketTracker: refund increases tokens', () => {
        const tracker = new TokenBucketTracker({ initialTokens: 5, maxTokens: 10 });
        tracker.consume('test@example.com'); // 5 -> 4
        tracker.refund('test@example.com');  // 4 -> 5
        assertEqual(tracker.getTokens('test@example.com'), 5, 'Refund should restore token');
    });

    test('TokenBucketTracker: refund cannot exceed maxTokens', () => {
        const tracker = new TokenBucketTracker({ initialTokens: 10, maxTokens: 10 });
        tracker.refund('test@example.com');
        assertEqual(tracker.getTokens('test@example.com'), 10, 'Refund should not exceed max');
    });

    test('TokenBucketTracker: getMaxTokens returns configured max', () => {
        const tracker = new TokenBucketTracker({ maxTokens: 100 });
        assertEqual(tracker.getMaxTokens(), 100, 'getMaxTokens should return 100');
    });

    test('TokenBucketTracker: reset restores initial tokens', () => {
        const tracker = new TokenBucketTracker({ initialTokens: 50, maxTokens: 50 });
        tracker.consume('test@example.com');
        tracker.consume('test@example.com');
        tracker.reset('test@example.com');
        assertEqual(tracker.getTokens('test@example.com'), 50, 'Reset should restore initial');
    });

    // ==========================================================================
    // BASE STRATEGY TESTS
    // ==========================================================================
    console.log('\n─── BaseStrategy Tests ───');

    test('BaseStrategy: cannot be instantiated directly', () => {
        try {
            new BaseStrategy();
            throw new Error('Should have thrown');
        } catch (e) {
            assertTrue(e.message.includes('abstract'), 'Should throw abstract error');
        }
    });

    test('BaseStrategy: isAccountUsable returns false for null account', () => {
        // Create a minimal subclass to test
        class TestStrategy extends BaseStrategy {
            selectAccount() { return { account: null, index: 0 }; }
        }
        const strategy = new TestStrategy();
        assertFalse(strategy.isAccountUsable(null, 'model'), 'Null account should not be usable');
    });

    test('BaseStrategy: isAccountUsable returns false for invalid account', () => {
        class TestStrategy extends BaseStrategy {
            selectAccount() { return { account: null, index: 0 }; }
        }
        const strategy = new TestStrategy();
        const account = { email: 'test@example.com', isInvalid: true };
        assertFalse(strategy.isAccountUsable(account, 'model'), 'Invalid account should not be usable');
    });

    test('BaseStrategy: isAccountUsable returns false for disabled account', () => {
        class TestStrategy extends BaseStrategy {
            selectAccount() { return { account: null, index: 0 }; }
        }
        const strategy = new TestStrategy();
        const account = { email: 'test@example.com', enabled: false };
        assertFalse(strategy.isAccountUsable(account, 'model'), 'Disabled account should not be usable');
    });

    test('BaseStrategy: isAccountUsable returns false for rate-limited model', () => {
        class TestStrategy extends BaseStrategy {
            selectAccount() { return { account: null, index: 0 }; }
        }
        const strategy = new TestStrategy();
        const account = {
            email: 'test@example.com',
            modelRateLimits: {
                'claude-sonnet': {
                    isRateLimited: true,
                    resetTime: Date.now() + 60000 // 1 minute in future
                }
            }
        };
        assertFalse(strategy.isAccountUsable(account, 'claude-sonnet'), 'Rate-limited model should not be usable');
    });

    test('BaseStrategy: isAccountUsable returns true for expired rate limit', () => {
        class TestStrategy extends BaseStrategy {
            selectAccount() { return { account: null, index: 0 }; }
        }
        const strategy = new TestStrategy();
        const account = {
            email: 'test@example.com',
            modelRateLimits: {
                'claude-sonnet': {
                    isRateLimited: true,
                    resetTime: Date.now() - 1000 // 1 second in past
                }
            }
        };
        assertTrue(strategy.isAccountUsable(account, 'claude-sonnet'), 'Expired rate limit should be usable');
    });

    test('BaseStrategy: getUsableAccounts filters correctly', () => {
        class TestStrategy extends BaseStrategy {
            selectAccount() { return { account: null, index: 0 }; }
        }
        const strategy = new TestStrategy();
        const accounts = [
            { email: 'a@example.com', enabled: true },
            { email: 'b@example.com', enabled: false },
            { email: 'c@example.com', enabled: true, isInvalid: true },
            { email: 'd@example.com', enabled: true }
        ];
        const usable = strategy.getUsableAccounts(accounts, 'model');
        assertEqual(usable.length, 2, 'Should have 2 usable accounts');
        assertEqual(usable[0].account.email, 'a@example.com');
        assertEqual(usable[1].account.email, 'd@example.com');
    });

    // ==========================================================================
    // STICKY STRATEGY TESTS
    // ==========================================================================
    console.log('\n─── StickyStrategy Tests ───');

    test('StickyStrategy: returns null for empty accounts', () => {
        const strategy = new StickyStrategy();
        const result = strategy.selectAccount([], 'model', { currentIndex: 0 });
        assertNull(result.account, 'Should return null for empty accounts');
    });

    test('StickyStrategy: keeps using current account when available', () => {
        const strategy = new StickyStrategy();
        const accounts = createMockAccounts(3);

        const result1 = strategy.selectAccount(accounts, 'model', { currentIndex: 0 });
        assertEqual(result1.account.email, 'account1@example.com');
        assertEqual(result1.index, 0);

        const result2 = strategy.selectAccount(accounts, 'model', { currentIndex: 0 });
        assertEqual(result2.account.email, 'account1@example.com', 'Should stick to same account');
        assertEqual(result2.index, 0);
    });

    test('StickyStrategy: switches when current account is rate-limited', () => {
        const strategy = new StickyStrategy();
        const accounts = createMockAccounts(3);
        // Rate-limit account1 for 5 minutes (longer than MAX_WAIT)
        accounts[0].modelRateLimits = {
            'model': { isRateLimited: true, resetTime: Date.now() + 300000 }
        };

        const result = strategy.selectAccount(accounts, 'model', { currentIndex: 0 });
        assertEqual(result.account.email, 'account2@example.com', 'Should switch to next available');
        assertEqual(result.index, 1);
    });

    test('StickyStrategy: returns waitMs when current account has short rate limit', () => {
        const strategy = new StickyStrategy();
        const accounts = createMockAccounts(1); // Only one account
        // Rate-limit for 30 seconds (less than MAX_WAIT of 2 minutes)
        accounts[0].modelRateLimits = {
            'model': { isRateLimited: true, resetTime: Date.now() + 30000 }
        };

        const result = strategy.selectAccount(accounts, 'model', { currentIndex: 0 });
        assertNull(result.account, 'Should return null when waiting');
        assertWithin(result.waitMs, 29000, 31000, 'Should return ~30s wait time');
    });

    test('StickyStrategy: switches when current account is disabled', () => {
        const strategy = new StickyStrategy();
        const accounts = createMockAccounts(3);
        accounts[0].enabled = false;

        const result = strategy.selectAccount(accounts, 'model', { currentIndex: 0 });
        assertEqual(result.account.email, 'account2@example.com', 'Should switch to next');
    });

    test('StickyStrategy: switches when current account is invalid', () => {
        const strategy = new StickyStrategy();
        const accounts = createMockAccounts(3);
        accounts[0].isInvalid = true;

        const result = strategy.selectAccount(accounts, 'model', { currentIndex: 0 });
        assertEqual(result.account.email, 'account2@example.com', 'Should switch to next');
    });

    test('StickyStrategy: wraps around when at end of list', () => {
        const strategy = new StickyStrategy();
        const accounts = createMockAccounts(3);
        accounts[2].isInvalid = true; // Last account invalid

        const result = strategy.selectAccount(accounts, 'model', { currentIndex: 2 });
        assertEqual(result.account.email, 'account1@example.com', 'Should wrap to first');
        assertEqual(result.index, 0);
    });

    test('StickyStrategy: clamps invalid currentIndex', () => {
        const strategy = new StickyStrategy();
        const accounts = createMockAccounts(3);

        const result = strategy.selectAccount(accounts, 'model', { currentIndex: 10 });
        assertEqual(result.account.email, 'account1@example.com', 'Should clamp to valid index');
        assertEqual(result.index, 0);
    });

    // ==========================================================================
    // ROUND-ROBIN STRATEGY TESTS
    // ==========================================================================
    console.log('\n─── RoundRobinStrategy Tests ───');

    test('RoundRobinStrategy: returns null for empty accounts', () => {
        const strategy = new RoundRobinStrategy();
        const result = strategy.selectAccount([], 'model');
        assertNull(result.account, 'Should return null for empty accounts');
    });

    test('RoundRobinStrategy: rotates through accounts', () => {
        const strategy = new RoundRobinStrategy();
        const accounts = createMockAccounts(3);

        const r1 = strategy.selectAccount(accounts, 'model');
        const r2 = strategy.selectAccount(accounts, 'model');
        const r3 = strategy.selectAccount(accounts, 'model');
        const r4 = strategy.selectAccount(accounts, 'model');

        // First call starts at cursor 0, looks at (0+1)%3 = 1
        // Then cursor becomes 1, next looks at (1+1)%3 = 2
        // Then cursor becomes 2, next looks at (2+1)%3 = 0
        // Then cursor becomes 0, next looks at (0+1)%3 = 1
        assertEqual(r1.account.email, 'account2@example.com', 'First should be account2');
        assertEqual(r2.account.email, 'account3@example.com', 'Second should be account3');
        assertEqual(r3.account.email, 'account1@example.com', 'Third should wrap to account1');
        assertEqual(r4.account.email, 'account2@example.com', 'Fourth should continue rotation');
    });

    test('RoundRobinStrategy: skips unavailable accounts', () => {
        const strategy = new RoundRobinStrategy();
        const accounts = createMockAccounts(3);
        accounts[1].enabled = false; // Disable account2

        const r1 = strategy.selectAccount(accounts, 'model');
        const r2 = strategy.selectAccount(accounts, 'model');
        const r3 = strategy.selectAccount(accounts, 'model');

        // account2 is skipped
        assertEqual(r1.account.email, 'account3@example.com');
        assertEqual(r2.account.email, 'account1@example.com');
        assertEqual(r3.account.email, 'account3@example.com');
    });

    test('RoundRobinStrategy: returns null when all accounts unavailable', () => {
        const strategy = new RoundRobinStrategy();
        const accounts = createMockAccounts(3);
        accounts.forEach(a => a.enabled = false);

        const result = strategy.selectAccount(accounts, 'model');
        assertNull(result.account, 'Should return null when all unavailable');
    });

    test('RoundRobinStrategy: resetCursor resets position', () => {
        const strategy = new RoundRobinStrategy();
        const accounts = createMockAccounts(3);

        strategy.selectAccount(accounts, 'model'); // Moves cursor
        strategy.selectAccount(accounts, 'model'); // Moves cursor
        strategy.resetCursor();

        const result = strategy.selectAccount(accounts, 'model');
        assertEqual(result.account.email, 'account2@example.com', 'Should start from beginning after reset');
    });

    // ==========================================================================
    // HYBRID STRATEGY TESTS
    // ==========================================================================
    console.log('\n─── HybridStrategy Tests ───');

    test('HybridStrategy: returns null for empty accounts', () => {
        const strategy = new HybridStrategy();
        const result = strategy.selectAccount([], 'model');
        assertNull(result.account, 'Should return null for empty accounts');
    });

    test('HybridStrategy: selects best scored account', () => {
        const strategy = new HybridStrategy({
            healthScore: { initial: 70 },
            tokenBucket: { initialTokens: 50, maxTokens: 50 }
        });
        const accounts = createMockAccounts(3);
        // Make account3 older (higher LRU score)
        accounts[2].lastUsed = Date.now() - 3600000; // 1 hour ago

        const result = strategy.selectAccount(accounts, 'model');
        // account3 should win due to higher LRU score
        assertEqual(result.account.email, 'account3@example.com', 'Oldest account should be selected');
    });

    test('HybridStrategy: filters out unhealthy accounts', () => {
        const strategy = new HybridStrategy({
            healthScore: { initial: 40, minUsable: 50 },
            tokenBucket: { initialTokens: 50, maxTokens: 50 }
        });
        const accounts = createMockAccounts(3);

        // All accounts start with health 40, which is below minUsable 50
        const result = strategy.selectAccount(accounts, 'model');
        assertNull(result.account, 'Should filter all accounts with low health');
    });

    test('HybridStrategy: filters out accounts without tokens', () => {
        const strategy = new HybridStrategy({
            healthScore: { initial: 70 },
            tokenBucket: { initialTokens: 0, maxTokens: 50 }
        });
        const accounts = createMockAccounts(3);

        const result = strategy.selectAccount(accounts, 'model');
        assertNull(result.account, 'Should filter all accounts without tokens');
    });

    test('HybridStrategy: consumes token on selection', () => {
        const strategy = new HybridStrategy({
            healthScore: { initial: 70 },
            tokenBucket: { initialTokens: 10, maxTokens: 50 }
        });
        const accounts = createMockAccounts(1);

        strategy.selectAccount(accounts, 'model');
        const tracker = strategy.getTokenBucketTracker();
        assertEqual(tracker.getTokens(accounts[0].email), 9, 'Token should be consumed');
    });

    test('HybridStrategy: onSuccess increases health', () => {
        const strategy = new HybridStrategy({
            healthScore: { initial: 70, successReward: 5 }
        });
        const account = { email: 'test@example.com' };

        strategy.onSuccess(account, 'model');
        const tracker = strategy.getHealthTracker();
        assertEqual(tracker.getScore('test@example.com'), 75, 'Health should increase');
    });

    test('HybridStrategy: onRateLimit decreases health', () => {
        const strategy = new HybridStrategy({
            healthScore: { initial: 70, rateLimitPenalty: -10 }
        });
        const account = { email: 'test@example.com' };

        strategy.onRateLimit(account, 'model');
        const tracker = strategy.getHealthTracker();
        assertEqual(tracker.getScore('test@example.com'), 60, 'Health should decrease');
    });

    test('HybridStrategy: onFailure decreases health and refunds token', () => {
        const strategy = new HybridStrategy({
            healthScore: { initial: 70, failurePenalty: -20 },
            tokenBucket: { initialTokens: 10, maxTokens: 50 }
        });
        const accounts = createMockAccounts(1);

        // First consume a token
        strategy.selectAccount(accounts, 'model');
        const tokensBefore = strategy.getTokenBucketTracker().getTokens(accounts[0].email);

        // Then fail
        strategy.onFailure(accounts[0], 'model');

        const healthTracker = strategy.getHealthTracker();
        const tokenTracker = strategy.getTokenBucketTracker();

        assertEqual(healthTracker.getScore(accounts[0].email), 50, 'Health should decrease by 20');
        assertEqual(tokenTracker.getTokens(accounts[0].email), tokensBefore + 1, 'Token should be refunded');
    });

    test('HybridStrategy: scoring formula weights work correctly', () => {
        // Test that health, tokens, and LRU all contribute to score
        const strategy = new HybridStrategy({
            healthScore: { initial: 100 },
            tokenBucket: { initialTokens: 50, maxTokens: 50 },
            weights: { health: 2, tokens: 5, lru: 0.1 }
        });

        const accounts = [
            { email: 'high-health@example.com', enabled: true, lastUsed: Date.now() },
            { email: 'old-account@example.com', enabled: true, lastUsed: Date.now() - 3600000 }
        ];

        // Both have same health and tokens, but old-account has higher LRU
        const result = strategy.selectAccount(accounts, 'model');
        assertEqual(result.account.email, 'old-account@example.com', 'Older account should win with LRU weight');
    });

    // ==========================================================================
    // STRATEGY FACTORY TESTS
    // ==========================================================================
    console.log('\n─── Strategy Factory Tests ───');

    test('createStrategy: creates StickyStrategy for "sticky"', () => {
        const strategy = createStrategy('sticky');
        assertTrue(strategy instanceof StickyStrategy, 'Should create StickyStrategy');
    });

    test('createStrategy: creates RoundRobinStrategy for "round-robin"', () => {
        const strategy = createStrategy('round-robin');
        assertTrue(strategy instanceof RoundRobinStrategy, 'Should create RoundRobinStrategy');
    });

    test('createStrategy: creates RoundRobinStrategy for "roundrobin"', () => {
        const strategy = createStrategy('roundrobin');
        assertTrue(strategy instanceof RoundRobinStrategy, 'Should accept roundrobin alias');
    });

    test('createStrategy: creates HybridStrategy for "hybrid"', () => {
        const strategy = createStrategy('hybrid');
        assertTrue(strategy instanceof HybridStrategy, 'Should create HybridStrategy');
    });

    test('createStrategy: falls back to HybridStrategy for unknown strategy', () => {
        const strategy = createStrategy('unknown');
        assertTrue(strategy instanceof HybridStrategy, 'Should fall back to HybridStrategy');
    });

    test('createStrategy: uses default when null', () => {
        const strategy = createStrategy(null);
        assertTrue(strategy instanceof HybridStrategy, 'Null should use default HybridStrategy');
    });

    test('createStrategy: is case-insensitive', () => {
        const s1 = createStrategy('STICKY');
        const s2 = createStrategy('Hybrid');
        const s3 = createStrategy('ROUND-ROBIN');
        assertTrue(s1 instanceof StickyStrategy);
        assertTrue(s2 instanceof HybridStrategy);
        assertTrue(s3 instanceof RoundRobinStrategy);
    });

    test('isValidStrategy: returns true for valid strategies', () => {
        assertTrue(isValidStrategy('sticky'));
        assertTrue(isValidStrategy('round-robin'));
        assertTrue(isValidStrategy('hybrid'));
        assertTrue(isValidStrategy('roundrobin'));
    });

    test('isValidStrategy: returns false for invalid strategies', () => {
        assertFalse(isValidStrategy('invalid'));
        assertFalse(isValidStrategy(''));
        assertFalse(isValidStrategy(null));
        assertFalse(isValidStrategy(undefined));
    });

    test('getStrategyLabel: returns correct labels', () => {
        assertEqual(getStrategyLabel('sticky'), 'Sticky (Cache Optimized)');
        assertEqual(getStrategyLabel('round-robin'), 'Round Robin (Load Balanced)');
        assertEqual(getStrategyLabel('roundrobin'), 'Round Robin (Load Balanced)');
        assertEqual(getStrategyLabel('hybrid'), 'Hybrid (Smart Distribution)');
    });

    test('getStrategyLabel: returns default label for unknown', () => {
        assertEqual(getStrategyLabel('unknown'), 'Hybrid (Smart Distribution)');
        assertEqual(getStrategyLabel(null), 'Hybrid (Smart Distribution)');
    });

    test('STRATEGY_NAMES contains all valid strategies', () => {
        assertDeepEqual(STRATEGY_NAMES, ['sticky', 'round-robin', 'hybrid']);
    });

    test('DEFAULT_STRATEGY is hybrid', () => {
        assertEqual(DEFAULT_STRATEGY, 'hybrid');
    });

    // ==========================================================================
    // INTEGRATION TESTS
    // ==========================================================================
    console.log('\n─── Integration Tests ───');

    test('Integration: Hybrid strategy recovers from rate limits', () => {
        const strategy = new HybridStrategy({
            healthScore: { initial: 70, rateLimitPenalty: -10, minUsable: 50 }
        });
        const accounts = createMockAccounts(2);

        // Rate limit first account multiple times
        for (let i = 0; i < 3; i++) {
            strategy.onRateLimit(accounts[0], 'model');
        }

        // Health of first account should be 40 (below minUsable 50)
        const healthTracker = strategy.getHealthTracker();
        assertEqual(healthTracker.getScore(accounts[0].email), 40);
        assertFalse(healthTracker.isUsable(accounts[0].email));

        // Selection should prefer second account
        const result = strategy.selectAccount(accounts, 'model');
        assertEqual(result.account.email, 'account2@example.com');
    });

    test('Integration: Token consumption limits requests', () => {
        const strategy = new HybridStrategy({
            tokenBucket: { initialTokens: 2, maxTokens: 10 }
        });
        const accounts = createMockAccounts(1);

        // Consume all tokens
        strategy.selectAccount(accounts, 'model'); // 2 -> 1
        strategy.selectAccount(accounts, 'model'); // 1 -> 0

        // Third request should fail (no tokens)
        const result = strategy.selectAccount(accounts, 'model');
        assertNull(result.account, 'Should return null when tokens exhausted');
    });

    test('Integration: Multi-model rate limiting is independent', () => {
        const strategy = new StickyStrategy();
        const accounts = createMockAccounts(2);

        // Rate limit account1 for model-a only
        accounts[0].modelRateLimits = {
            'model-a': { isRateLimited: true, resetTime: Date.now() + 300000 }
        };

        // model-a should switch to account2
        const resultA = strategy.selectAccount(accounts, 'model-a', { currentIndex: 0 });
        assertEqual(resultA.account.email, 'account2@example.com');

        // model-b should still use account1
        const resultB = strategy.selectAccount(accounts, 'model-b', { currentIndex: 0 });
        assertEqual(resultB.account.email, 'account1@example.com');
    });

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
