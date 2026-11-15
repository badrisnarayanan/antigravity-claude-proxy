// Browser globals loaded via <script> tags in public/index.html.
// Keys are quoted because aislop's globals parser skips an unquoted first key.
export default [
    {
        files: ['public/**/*.js'],
        languageOptions: {
            globals: {
                'Alpine': 'readonly',
                'Chart': 'readonly',
                'Redact': 'readonly'
            }
        }
    }
];
