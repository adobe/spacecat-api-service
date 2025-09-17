/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// Apply filters to data arrays with case-insensitive exact matching
export const applyFilters = (rawData, filterFields) => {
  const data = { ...rawData };
  const filterArray = (array) => {
    const filteredArray = array.filter((item) => {
      const itemMatchesFilter = Object.entries(filterFields).every(([attr, value]) => {
        const itemValue = item[attr];
        if (itemValue == null) return false;
        return String(itemValue).toLowerCase() === String(value).toLowerCase();
      });
      return itemMatchesFilter;
    });
    return filteredArray;
  };

  if (data[':type'] === 'sheet' && data.data) {
    data.data = filterArray(data.data);
  } else if (data[':type'] === 'multi-sheet') {
    Object.keys(data).forEach((key) => {
      if (key !== ':type' && data[key]?.data) {
        data[key].data = filterArray(data[key].data);
      }
    });
  }
  return data;
};

// Apply inclusions to data arrays to remove specified attributes
export const applyInclusions = (rawData, includeFields) => {
  const data = { ...rawData };
  const includeFromArray = (rawArray) => {
    const includeResult = rawArray.map((item) => {
      const newItem = {};
      includeFields.forEach((fieldName) => {
        const value = item[fieldName];
        if (value) {
          newItem[fieldName] = item[fieldName];
        }
      });
      return newItem;
    });
    return includeResult;
  };

  if (data[':type'] === 'sheet' && data.data) {
    data.data = includeFromArray(data.data);
  } else if (data[':type'] === 'multi-sheet') {
    Object.keys(data).forEach((key) => {
      if (key !== ':type' && data[key]?.data) {
        data[key].data = includeFromArray(data[key].data);
      }
    });
  }
  return data;
};

// Apply exclusions to data arrays to remove specified attributes
export const applyExclusions = (rawData, excludeFields) => {
  const data = { ...rawData };
  const excludeFromArray = (array) => array.map((item) => {
    const filteredItem = { ...item };
    excludeFields.forEach((attr) => {
      delete filteredItem[attr];
    });
    return filteredItem;
  });

  if (data[':type'] === 'sheet' && data.data) {
    data.data = excludeFromArray(data.data);
  } else if (data[':type'] === 'multi-sheet') {
    Object.keys(data).forEach((key) => {
      if (key !== ':type' && data[key]?.data) {
        data[key].data = excludeFromArray(data[key].data);
      }
    });
  }
  return data;
};

// Apply groups to data arrays to group by specified attributes
export const applyGroups = (rawData, groupByFields) => {
  const data = { ...rawData };

  const groupArray = (array) => {
    // Create a map to group items by the combination of grouping attributes
    const groupMap = new Map();

    array.forEach((item) => {
      // Create a key from the grouping attributes
      const groupKey = groupByFields.map((attr) => `${attr}:${item[attr] ?? 'null'}`).join('|');

      // Extract grouping attributes (ensure they're always present)
      const groupingAttributes = {};
      groupByFields.forEach((attr) => {
        // Use null instead of undefined for JSON serialization
        groupingAttributes[attr] = item[attr] ?? null;
      });

      // Create record without grouping attributes
      const record = { ...item };
      groupByFields.forEach((attr) => {
        delete record[attr];
      });

      // Add to group
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          ...groupingAttributes,
          records: [],
        });
      }

      groupMap.get(groupKey).records.push(record);
    });

    // Convert map to array
    return Array.from(groupMap.values());
  };

  if (data[':type'] === 'sheet' && data.data) {
    data.data = groupArray(data.data);
  } else if (data[':type'] === 'multi-sheet') {
    Object.keys(data).forEach((key) => {
      if (key !== ':type' && data[key]?.data) {
        data[key].data = groupArray(data[key].data);
      }
    });
  }

  return data;
};

// Apply mappings to data arrays to transform field names and values
export const applyMappings = (rawData, mappingConfig) => {
  const data = { ...rawData };

  const mapArray = (array, mappings) => array.map((item) => {
    const mappedItem = { ...item };

    Object.entries(mappings).forEach(([originalField, newField]) => {
      const value = item[originalField];
      if (value) {
        mappedItem[newField] = item[originalField];
        delete mappedItem[originalField];
      }
    });

    return mappedItem;
  });

  Object.keys(data).forEach((key) => {
    if (key !== ':type' && data[key]?.data && mappingConfig.mappings?.[key]) {
      const mappings = mappingConfig.mappings[key];
      data[key].data = mapArray(data[key].data, mappings);
    }
  });

  return data;
};
