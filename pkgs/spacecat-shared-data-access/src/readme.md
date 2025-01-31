# ElectroDB Entity Framework

## Overview

This entity framework streamlines the definition, querying, and manipulation of domain entities in a DynamoDB-based application. Built atop [ElectroDB](https://electrodb.dev/), it provides a consistent layer for schema definition, indexing, and robust CRUD operations, while adding conveniences like automatic indexing methods and reference handling.

By adhering to this framework’s conventions, you can introduce and manage new entities with minimal boilerplate and complexity.

## Core Concepts

### Entities
An *entity* represents a domain concept (e.g., `User`, `Organization`, `Order`) persisted in the database. Each entity is defined by a schema, specifying attributes, indexes, and references to other entities. The schema integrates with ElectroDB, ensuring a uniform approach to modeling data.

### Models
A *Model* is a class representing a single instance of an entity. It provides:

- Attribute getters and setters generated based on the schema.
- Methods for persisting changes (`save()`), and removing entities (`remove()`).
- Methods to fetch referenced entities (via `belongs_to`, `has_one`, `has_many` references).

Models extend `BaseModel`, which handles most of the common logic.

### Collections
A *Collection* operates on sets of entities. While `Model` focuses on individual records, `Collection` is for batch and query-level operations:

- Query methods like `findById()`, `all()`, and index-derived methods.
- Batch creation and update methods (`createMany`, `_saveMany`).
- Automatic generation of `allBy...` and `findBy...` convenience methods based on defined indexes.

Collections extend `BaseCollection`, which generates query methods at runtime based on your schema definitions.

### Schema Builder
The `SchemaBuilder` is a fluent API to define an entity’s schema:

- **Attributes:** Configure entity fields and their validation.
- **Indexes:** Specify primary and secondary indexes for common queries.
- **References:** Define entity relationships (e.g., `User` belongs to `Organization`).

The `SchemaBuilder` enforces naming conventions and sets defaults, reducing repetitive configuration.

**Note on Indexes:** Add indexes thoughtfully. Every extra index adds cost and complexity. Only create indexes for well-understood, frequently-needed query patterns.

### Entity Registry
The `EntityRegistry` aggregates all entities, their schemas, and their collections. It ensures consistent lookup and retrieval of any registered entity’s collection. When you add a new entity, you must register it with the `EntityRegistry` so the rest of the application can discover it.

## Default Attributes and Indexes

When you create a schema with `SchemaBuilder`, the following attributes are automatically defined:

1. **ID (Primary Key):** A UUID-based primary key (`${entityName}Id`), ensuring unique identification.
2. **createdAt:** A timestamp (ISO string) set at entity creation.
3. **updatedAt:** A timestamp (ISO string) updated on each modification.

A primary index is also set up, keyed by the `${entityName}Id` attribute, guaranteeing a straightforward way to retrieve entities by their unique ID.

## Auto-Generated Methods

### `BaseCollection`

`BaseCollection` automatically generates `allBy...` and `findBy...` methods derived from your defined indexes. For example, if your schema defines an index composed of `opportunityId`, `status`, and `createdAt`, `BaseCollection` will generate:

- `allByOpportunityId(opportunityId, options?)`
- `findByOpportunityId(opportunityId, options?)`
- `allByOpportunityIdAndStatus(opportunityId, status, options?)`
- `findByOpportunityIdAndStatus(opportunityId, status, options?)`
- `allByOpportunityIdAndStatusAndCreatedAt(opportunityId, status, createdAt, options?)`
- `findByOpportunityIdAndStatusAndCreatedAt(opportunityId, status, createdAt, options?)`

**allBy...** methods return arrays of matching entities, while **findBy...** methods return a single (or the first matching) entity. Both can accept an optional `options` object for filtering, ordering, attribute selection, and pagination.

**Example:**
```js
const Suggestion = dataAccess.Suggestion;

// Retrieve all suggestions by `opportunityId`
const results = await Suggestion.allByOpportunityId('op-12345');

// Retrieve a single suggestion by `opportunityId` and `status`
const single = await Suggestion.findByOpportunityIdAndStatus('op-12345', 'OPEN');
```

### `BaseModel`

`BaseModel` provides methods for CRUD operations and reference handling:

- `save()`: Persists changes to the entity.
- `remove()`: Deletes the entity from the database.
- `get...()`: Getters for entity attributes.
- `set...()`: Setters for entity attributes.

Additionally, `BaseModel` generates methods to fetch referenced entities. 
For example, if `User` belongs to `Organization`, `BaseModel` will create:

- `getOrganization()`: Fetch the referenced `Organization` entity.
- `getOrganizationId()`: Retrieve the `Organization` ID.
- `setOrganizationId(organizationId)`: Update the `Organization` reference.

Conversely, the `Organization` entity will have:

- `getUsers()`: Fetch all `User` entities referencing this `Organization`.
- And with the `User`-Schema's `belongs_to` reciprocal reference expressing filterable sort keys, e.g. "email", "location":
  - `getUsersByEmail(email)`: Fetch all `User` entities referencing this `Organization` with a specific email."
  - `getUsersByEmailAndLocation(email, location)`: Fetch all `User` entities referencing this `Organization` with a specific email and location.

**Example:**
```js
const user = await User.findById('usr-abc123');

// Work with attributes
console.log(user.getEmail());   // e.g. "john@example.com"
user.setName('John Smith');
await user.save();

// Fetch referenced entity
const org = await user.getOrganization();
console.log(org.getName());
```

## Step-by-Step: Adding a New Entity

Follow these steps to introduce a new entity into the framework.

### 1. Define the Schema
Create `user.schema.js`:

```js
import SchemaBuilder from '../base/schema.builder.js';
import User from './user.model.js';
import UserCollection from './user.collection.js';

const userSchema = new SchemaBuilder(User, UserCollection)
  .addAttribute('email', {
    type: 'string',
    required: true,
    validate: (value) => value.includes('@'),
  })
  .addAttribute('name', { type: 'string', required: true })
  .addAllIndex(['email'])
  .addReference('belongs_to', 'Organization') // Adds organizationId and byOrganizationId index
  .build();

export default userSchema;
```

### 2. Implement the Model
Create `user.model.js`:

```js
import BaseModel from '../base/base.model.js';

class UserModel extends BaseModel {
  // Additional domain logic methods can be added here if needed.
}

export default UserModel;
```

### 3. Implement the Collection
Create `user.collection.js`:

```js
import BaseCollection from '../base/base.collection.js';
import UserModel from './user.model.js';
import userSchema from './user.schema.js';

class UserCollection extends BaseCollection {
  // Additional domain logic collection methods can be added here if needed.
  async findByEmail(email) {
    return this.findByIndexKeys({ email });
  }
}

export default UserCollection;
```

### 4. Register the Entity
In `entity.registry.js` (or equivalent):

```js
import UserSchema from '../user/user.schema.js';
import UserCollection from '../user/user.collection.js';

EntityRegistry.registerEntity(UserSchema, UserCollection);
```

### 5. Update DynamoDB Configuration and `schema.json`

After defining indexes in the schema, **manually add these indexes to your DynamoDB table configuration**. DynamoDB does not automatically create GSIs. You must:

- Use the AWS Console, CLI, or CloudFormation/Terraform templates to define these GSIs.
- Update your `schema.json` or another documentation file to reflect the newly created indexes, so the team knows which indexes exist and what query patterns they support.

### 6. Use the Entity
```js
const { User, Organization } = dataAccess;

// Create a user
const newUser = await User.create({ email: 'john@example.com', name: 'John Doe' });

// Find user by ID
const user = await User.findById(newUser.getId());

// Get the user organization
const org = await user.getOrganization();

// ...or in reverse
const anOrg = await Organization.findById(user.getOrganizationId());
const orgUsers = await anOrg.getUsers();

// Update user and save
user.setName('John X. Doe');
await user.save();
```

## Consideration for Indexes

Indexes cost money and complexity. Do not add indexes lightly. Determine which query patterns you truly need and only then introduce additional indexes.

## Data Access Service

You can use the data layer by obtaining a service instance through the `createDataAccess` function:

```javascript
const { createDataAccess } = require('@adobe/spacecat-shared-data-access');

const dataAccess = createDataAccess({
  tableNameData: 'spacecat-services-data-dev',
});

// You can now use the dataAccess object to interact with the data layer
const sites = await dataAccess.Site.getSites();
```

