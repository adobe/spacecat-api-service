Please ensure your pull request adheres to the following guidelines:
- [ ] make sure to link the related issues in this description. Or if there's no issue created, make sure you 
  describe here the problem you're solving.
- [ ] when merging / squashing, make sure the fixed issue references are visible in the commits, for easy compilation of release notes

If the PR is changing the API specification:
- [ ] make sure you add a "Not implemented yet" note the endpoint description, if the implementation is not ready 
  yet. Ideally, return a 501 status code with a message explaining the feature is not implemented yet.
- [ ] make sure you add at least one example of the request and response.

If the PR is changing the API implementation or an entity exposed through the API:
- [ ] make sure you update the API specification and the examples to reflect the changes.

If the PR is introducing a new audit type:
- [ ] make sure you update the API specification with the type, schema of the audit result and an example

## Related Issues


Thanks for contributing!
