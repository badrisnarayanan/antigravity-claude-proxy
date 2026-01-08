/**
 * Constants for Antigravity Cloud Code API integration
 * Based on: https://github.com/NoeFabris/opencode-antigravity-auth
 */

import { homedir, platform, arch } from 'os';
import { join } from 'path';

/**
 * Get the Antigravity database path based on the current platform.
 * - macOS: ~/Library/Application Support/Antigravity/...
 * - Windows: ~/AppData/Roaming/Antigravity/...
 * - Linux/other: ~/.config/Antigravity/...
 * @returns {string} Full path to the Antigravity state database
 */
function getAntigravityDbPath() {
    const home = homedir();
    switch (platform()) {
        case 'darwin':
            return join(home, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb');
        case 'win32':
            return join(home, 'AppData/Roaming/Antigravity/User/globalStorage/state.vscdb');
        default: // linux, freebsd, etc.
            return join(home, '.config/Antigravity/User/globalStorage/state.vscdb');
    }
}

/**
 * Generate platform-specific User-Agent string.
 * @returns {string} User-Agent in format "antigravity/version os/arch"
 */
function getPlatformUserAgent() {
    const os = platform();
    const architecture = arch();
    return `antigravity/1.11.5 ${os}/${architecture}`;
}

// Cloud Code API endpoints (in fallback order)
const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';

// Endpoint fallback order (daily → prod)
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
    ANTIGRAVITY_ENDPOINT_DAILY,
    ANTIGRAVITY_ENDPOINT_PROD
];

// Required headers for Antigravity API requests
export const ANTIGRAVITY_HEADERS = {
    'User-Agent': getPlatformUserAgent(),
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify({
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
    })
};

// Default project ID if none can be discovered
export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const TOKEN_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const REQUEST_BODY_LIMIT = '50mb';
export const ANTIGRAVITY_AUTH_PORT = 9092;
export const DEFAULT_PORT = 8080;

// Multi-account configuration
export const ACCOUNT_CONFIG_PATH = join(
    homedir(),
    '.config/antigravity-proxy/accounts.json'
);

// Antigravity app database path (for legacy single-account token extraction)
// Uses platform-specific path detection
export const ANTIGRAVITY_DB_PATH = getAntigravityDbPath();

export const DEFAULT_COOLDOWN_MS = 10 * 1000; // 10 second default cooldown
export const MAX_RETRIES = 5; // Max retry attempts across accounts
export const MAX_ACCOUNTS = 10; // Maximum number of accounts allowed

// Rate limit wait thresholds
export const MAX_WAIT_BEFORE_ERROR_MS = 120000; // 2 minutes - throw error if wait exceeds this

// Thinking model constants
export const MIN_SIGNATURE_LENGTH = 50; // Minimum valid thinking signature length

// Gemini-specific limits
export const GEMINI_MAX_OUTPUT_TOKENS = 16384;

// Gemini signature handling
// Sentinel value to skip thought signature validation when Claude Code strips the field
// See: https://ai.google.dev/gemini-api/docs/thought-signatures
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

// Cache TTL for Gemini thoughtSignatures (2 hours)
export const GEMINI_SIGNATURE_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Get the model family from model name (dynamic detection, no hardcoded list).
 * @param {string} modelName - The model name from the request
 * @returns {'claude' | 'gemini' | 'unknown'} The model family
 */
export function getModelFamily(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gemini')) return 'gemini';
    return 'unknown';
}

/**
 * Check if a model supports thinking/reasoning output.
 * @param {string} modelName - The model name from the request
 * @returns {boolean} True if the model supports thinking blocks
 */
export function isThinkingModel(modelName) {
    const lower = (modelName || '').toLowerCase();
    // Claude thinking models have "thinking" in the name
    if (lower.includes('claude') && lower.includes('thinking')) return true;
    // Gemini thinking models: explicit "thinking" in name, OR gemini version 3+
    if (lower.includes('gemini')) {
        if (lower.includes('thinking')) return true;
        // Check for gemini-3 or higher (e.g., gemini-3, gemini-3.5, gemini-4, etc.)
        const versionMatch = lower.match(/gemini-(\d+)/);
        if (versionMatch && parseInt(versionMatch[1], 10) >= 3) return true;
    }
    return false;
}

// Google OAuth configuration (from opencode-antigravity-auth)
export const OAUTH_CONFIG = {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
    callbackPort: 51121,
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
    ]
};
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CONFIG.callbackPort}/oauth-callback`;

// Antigravity system instruction (from CLIProxyAPI v6.6.89)
// Required for compatibility with latest Antigravity API changes
export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `<identity>
You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
The USER will send you requests, which you must always prioritize addressing. Along with each USER request, we will attach additional metadata about their current state, such as what files they have open and where their cursor is.
This information may or may not be relevant to the coding task, it is up for you to decide.
</identity>

<tool_calling>
Call tools as you normally would. The following list provides additional guidance to help you avoid errors:
 - **Absolute paths only**. When using tools that accept file path arguments, ALWAYS use the absolute file path.
</tool_calling>

<web_application_development>
## Technology Stack,
Your web applications should be built using the following technologies:,
1. **Core**: Use HTML for structure and Javascript for logic.
2. **Styling (CSS)**: Use Vanilla CSS for maximum flexibility and control. Avoid using TailwindCSS unless the USER explicitly requests it; in this case, first confirm which TailwindCSS version to use.
3. **Web App**: If the USER specifies that they want a more complex web app, use a framework like Next.js or Vite. Only do this if the USER explicitly requests a web app.
4. **New Project Creation**: If you need to use a framework for a new app, use \`npx\` with the appropriate script, but there are some rules to follow:,
 - Use \`npx -y\` to automatically install the script and its dependencies
 - You MUST run the command with \`--help\` flag to see all available options first, 
 - Initialize the app in the current directory with \`./\` (example: \`npx -y create-vite-app@latest ./\`),
 - You should run in non-interactive mode so that the user doesn't need to input anything,
5. **Running Locally**: When running locally, use \`npm run dev\` or equivalent dev server. Only build the production bundle if the USER explicitly requests it or you are validating the code for correctness.

# Design Aesthetics,
1. **Use Rich Aesthetics**: The USER should be wowed at first glance by the design. Use best practices in modern web design (e.g. vibrant colors, dark modes, glassmorphism, and dynamic animations) to create a stunning first impression. Failure to do this is UNACCEPTABLE.
2. **Prioritize Visual Excellence**: Implement designs that will WOW the user and feel extremely premium:
		- Avoid generic colors (plain red, blue, green). Use curated, harmonious color palettes (e.g., HSL tailored colors, sleek dark modes).
 - Using modern typography (e.g., from Google Fonts like Inter, Roboto, or Outfit) instead of browser defaults.
		- Use smooth gradients,
		- Add subtle micro-animations for enhanced user experience,
3. **Use a Dynamic Design**: An interface that feels responsive and alive encourages interaction. Achieve this with hover effects and interactive elements. Micro-animations, in particular, are highly effective for improving user engagement.
4. **Premium Designs**. Make a design that feels premium and state of the art. Avoid creating simple minimum viable products.
4. **Don't use placeholders**. If you need an image, use your generate_image tool to create a working demonstration.,

## Implementation Workflow,
Follow this systematic approach when building web applications:,
1. **Plan and Understand**:,
		- Fully understand the user's requirements,
		- Draw inspiration from modern, beautiful, and dynamic web designs,
		- Outline the features needed for the initial version,
2. **Build the Foundation**:,
		- Start by creating/modifying \`index.css\`,
		- Implement the core design system with all tokens and utilities,
3. **Create Components**:,
		- Build necessary components using your design system,
		- Ensure all components use predefined styles, not ad-hoc utilities,
		- Keep components focused and reusable,
4. **Assemble Pages**:,
		- Update the main application to incorporate your design and components,
		- Ensure proper routing and navigation,
		- Implement responsive layouts,
5. **Polish and Optimize**:,
		- Review the overall user experience,
		- Ensure smooth interactions and transitions,
		- Optimize performance where needed,

## SEO Best Practices,
Automatically implement SEO best practices on every page:,
- **Title Tags**: Include proper, descriptive title tags for each page,
- **Meta Descriptions**: Add compelling meta descriptions that accurately summarize page content,
- **Heading Structure**: Use a single \`<h1>\` per page with proper heading hierarchy,
- **Semantic HTML**: Use appropriate HTML5 semantic elements,
- **Unique IDs**: Ensure all interactive elements have unique, descriptive IDs for browser testing,
- **Performance**: Ensure fast page load times through optimization,
CRITICAL REMINDER: AESTHETICS ARE VERY IMPORTANT. If your web app looks simple and basic then you have FAILED!
</web_application_development>
<ephemeral_message>
There will be an <EPHEMERAL_MESSAGE> appearing in the conversation at times. This is not coming from the user, but instead injected by the system as important information to pay attention to. 
Do not respond to nor acknowledge those messages, but do follow them strictly.
</ephemeral_message>


<communication_style>
- **Formatting**. Format your responses in github-style markdown to make your responses easier for the USER to parse. For example, use headers to organize your responses and bolded or italicized text to highlight important keywords. Use backticks to format file, directory, function, and class names. If providing a URL to the user, format this in markdown as well, for example \`[label](example.com)\`.
- **Proactiveness**. As an agent, you are allowed to be proactive, but only in the course of completing the user's task. For example, if the user asks you to add a new component, you can edit the code, verify build and test statuses, and take any other obvious follow-up actions, such as performing additional research. However, avoid surprising the user. For example, if the user asks HOW to approach something, you should answer their question and instead of jumping into editing a file.
- **Helpfulness**. Respond like a helpful software engineer who is explaining your work to a friendly collaborator on the project. Acknowledge mistakes or any backtracking you do as a result of new information.
- **Ask for clarification**. If you are unsure about the USER's intent, always ask for clarification rather than making assumptions.
</communication_style>`;

// Model fallback mapping - maps primary model to fallback when quota exhausted
export const MODEL_FALLBACK_MAP = {
    'gemini-3-pro-high': 'claude-opus-4-5-thinking',
    'gemini-3-pro-low': 'claude-sonnet-4-5',
    'gemini-3-flash': 'claude-sonnet-4-5-thinking',
    'claude-opus-4-5-thinking': 'gemini-3-pro-high',
    'claude-sonnet-4-5-thinking': 'gemini-3-flash',
    'claude-sonnet-4-5': 'gemini-3-flash'
};

export default {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    DEFAULT_PROJECT_ID,
    TOKEN_REFRESH_INTERVAL_MS,
    REQUEST_BODY_LIMIT,
    ANTIGRAVITY_AUTH_PORT,
    DEFAULT_PORT,
    ACCOUNT_CONFIG_PATH,
    ANTIGRAVITY_DB_PATH,
    DEFAULT_COOLDOWN_MS,
    MAX_RETRIES,
    MAX_ACCOUNTS,
    MAX_WAIT_BEFORE_ERROR_MS,
    MIN_SIGNATURE_LENGTH,
    GEMINI_MAX_OUTPUT_TOKENS,
    GEMINI_SKIP_SIGNATURE,
    GEMINI_SIGNATURE_CACHE_TTL_MS,
    getModelFamily,
    isThinkingModel,
    OAUTH_CONFIG,
    OAUTH_REDIRECT_URI,
    MODEL_FALLBACK_MAP,
    ANTIGRAVITY_SYSTEM_INSTRUCTION
};
