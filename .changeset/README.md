# Changesets

Run `npm run changeset` for a change that should be released. Select
`@grinry/godot-mcp`, choose a patch, minor, or major bump, and write a summary.
Commit the generated Markdown file with your change.

GitHub Actions collects changesets into a release pull request. Merging that
pull request publishes the new version to npm. See
[the release instructions](../CONTRIBUTING.md#releases) for maintainer setup.
