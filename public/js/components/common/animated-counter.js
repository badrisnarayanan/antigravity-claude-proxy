/**
 * Animated Counter Component
 * smoothly transitions numbers from start to end value
 */
window.Components = window.Components || {};

window.Components.animatedCounter = (initialValue = 0, duration = 1000) => ({
    current: 0,
    target: initialValue,
    duration: duration,
    start: 0,
    animationFrame: null,

    init() {
        this.current = 0;
        this.animate();

        this.$watch('target', (newValue) => {
            this.start = this.current;
            this.animate();
        });
    },

    animate() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
        }

        const startTime = performance.now();
        const startValue = this.start;
        const change = this.target - startValue;

        const step = (timestamp) => {
            const elapsed = timestamp - startTime;
            const progress = Math.min(elapsed / this.duration, 1);

            // Ease out quart
            const ease = 1 - Math.pow(1 - progress, 4);

            this.current = startValue + (change * ease);

            if (progress < 1) {
                this.animationFrame = requestAnimationFrame(step);
            } else {
                this.current = this.target;
                this.animationFrame = null;
            }
        };

        this.animationFrame = requestAnimationFrame(step);
    }
});
