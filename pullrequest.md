feat: merge upstream refactor & robust error handling
```
```

## Description;
```markdown
merged upstream changes so its all modular now.. ported over all the important stuff to the new structure.. specifically the model-specific rate limiting (so one model restriction doesnt block the whole account) and the network error handling implementation.. made it so accounts dont get perma-banned for transient network errors (like fetch failures).. also made sure the openai compatible endpoints still work with the new setup.. basically just merged everything and kept the good stuff..
```