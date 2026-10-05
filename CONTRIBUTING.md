# Contributing to Godot MCP

Thank you for considering contributing to Godot MCP! This document outlines the process for contributing to the project.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## How Can I Contribute?

### Reporting Bugs

- Check if the bug has already been reported in the Issues section
- Use the bug report template if available
- Include detailed steps to reproduce the bug
- Include any relevant logs or screenshots
- Specify your environment (OS, Godot version, etc.)

### Suggesting Enhancements

- Check if the enhancement has already been suggested in the Issues section
- Use the feature request template if available
- Clearly describe the enhancement and its benefits
- Consider how the enhancement fits into the project's scope

### Pull Requests

1. Fork the repository
2. Create a new branch for your feature or bugfix (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests if available
5. Commit your changes with clear commit messages
6. Push to your branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## Development Process

### Setting Up the Development Environment

1. Clone the repository
2. Install dependencies with `npm install`
3. Build the project with `npm run build`
4. For development with auto-rebuild, use `npm run watch`

### Project Structure

```
godot-mcp/
├── src/             # Source code
│   └── index.ts     # Main server implementation
├── build/           # Compiled JavaScript (generated)
├── tests/           # Test files (future)
├── examples/        # Example Godot projects (future)
├── LICENSE          # MIT License
├── README.md        # Documentation
├── CONTRIBUTING.md  # Contribution guidelines
├── package.json     # Project configuration
└── tsconfig.json    # TypeScript configuration
```

### Formatting and linting

Biome formats JavaScript, TypeScript, and JSON with two-space indentation and
single quotes in JavaScript/TypeScript, and applies recommended lint rules and
import sorting. Generated output and the npm-managed lockfile are excluded.
GDScript, Markdown, and YAML require separate review.

- `npm run check`: verify formatting, lint, and import sorting without modifying files.
- `npm run check:fix`: apply formatting, safe lint fixes, and import sorting.
- `npm run format`: apply formatting only.
- `npm run lint`: check lint rules only.

Warnings fail checks. The existing server has scoped exceptions for explicit
`any` and non-null assertions; prefer precise types and explicit guards in new
code. CI and release workflows run `npm run check`.

### Code Style

- Follow the existing code style in the project
- Use TypeScript for type safety
- Include JSDoc comments for all functions and classes
- Write clear and descriptive variable and function names
- Use meaningful interfaces for complex objects
- Handle errors gracefully with detailed error messages

### Debugging

For debugging the MCP server:

1. Set the `DEBUG` environment variable to `true`
2. Use the MCP Inspector for interactive debugging:
   ```bash
   npm run inspector
   ```
3. Check the logs for detailed information about what's happening

### Adding New Tools

When adding new tools to the MCP server:

1. Define the tool in the `setupToolHandlers` method
2. Create a handler method for the tool
3. Add proper input validation and error handling
4. Update the README.md with documentation for the new tool
5. Update the Features section in the README.md
6. Update the autoApprove section in the configuration examples
7. Add tests for the new functionality

#### Recently Added Tools

The following tools have been recently added:

- **get_project_info**: Retrieves metadata about a Godot project
  - Analyzes project structure
  - Returns information about scenes, scripts, and assets
  - Helps LLMs understand the organization of Godot projects
  
- **capture_screenshot**: Takes a screenshot of a running Godot project
  - Requires an active Godot process
  - Saves the screenshot to the specified path
  - Useful for visual debugging and feedback

Example:

```typescript
// In setupToolHandlers
{
  name: 'your_new_tool',
  description: 'Description of what your tool does',
  inputSchema: {
    type: 'object',
    properties: {
      param1: {
        type: 'string',
        description: 'Description of parameter 1',
      },
    },
    required: ['param1'],
  },
}

// Add handler method
private async handleYourNewTool(args: any) {
  // Validate input
  if (!args.param1) {
    return this.createErrorResponse(
      'Parameter 1 is required',
      ['Provide a valid value for parameter 1']
    );
  }

  try {
    // Implement tool functionality
    // ...

    return {
      content: [
        {
          type: 'text',
          text: 'Result of your tool',
        },
      ],
    };
  } catch (error: any) {
    return this.createErrorResponse(
      `Failed to execute tool: ${error?.message || 'Unknown error'}`,
      [
        'Possible solution 1',
        'Possible solution 2'
      ]
    );
  }
}
```

### Cross-Platform Compatibility

When making changes, ensure they work across different platforms:

- Use path utilities from Node.js (`path.join`, etc.) instead of hardcoded path separators
- Test on different operating systems if possible
- Consider different Godot installation locations
- Use environment variables for configuration

## Testing

- Add tests for new features when possible
- Ensure all tests pass before submitting a Pull Request
- Test on different platforms if possible
- Test with different Godot versions

## Documentation

- Keep README.md up to date with new features
- Document all tools and their parameters
- Include examples for new functionality
- Update the troubleshooting section with common issues

## Questions?

If you have any questions about contributing, feel free to open an issue for discussion.

Thank you for your contributions!

## Releases

The public npm package for this fork is `@grinry/godot-mcp`.

### Adding a changeset

1. Run `npm run changeset` after making a releasable change.
2. Select `@grinry/godot-mcp`, choose the appropriate version bump, and describe the change.
3. Commit the generated `.changeset/*.md` file with the implementation.

Changesets determines version bumps from these files, rather than commit messages.
Documentation-only changes do not need a changeset unless they should trigger a release.

### One-time maintainer setup

1. Ensure your npm account owns the `@grinry` scope and can publish `@grinry/godot-mcp`.
2. In the npm settings for `@grinry/godot-mcp`, add a **Trusted Publisher** for
   **GitHub Actions** with these exact values:
   - Organization or user: `grinry`
   - Repository: `godot-mcp`
   - Workflow filename: `release.yml` (without `.github/workflows/`)
   - Environment name: leave blank
   - Allowed actions: enable direct `npm publish`

   The workflow uses OIDC on a GitHub-hosted runner, so no `NPM_TOKEN` secret or
   token rotation is needed. It installs npm 11 (trusted publishing requires npm
   11.5.1 or later) and grants `id-token: write` to request short-lived publishing
   credentials. See [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
3. Under [Actions settings](https://github.com/grinry/godot-mcp/settings/actions),
   enable **Allow GitHub Actions to create and approve pull requests**. If branch
   protection requires checks on release PRs, ensure those checks can run on
   bot-created PRs; GitHub's default `GITHUB_TOKEN` does not trigger other workflows.

### Automated release flow

On pushes to `main`, `.github/workflows/release.yml` installs dependencies and
runs Changesets. Pending changesets create or update a release PR containing the
version bump, `CHANGELOG.md`, and synchronized `package-lock.json`.

Merge the release PR to build and publish the new version publicly to npm and
create a GitHub release. The fork's first release was `0.1.2`, following the
inherited `0.1.1` version. You can also run the workflow manually on `main` to
retry a failed publication.

For local inspection, `npm run version-packages` consumes changesets and updates
versions and the lockfile. `npm run release` builds and publishes using your npm
credentials; only run it when you intend to publish.
