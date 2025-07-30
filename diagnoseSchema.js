import fs from 'fs';

function main() {
  console.log('Analyzing subgraph schema...');
  
  let schemaData;
  try {
    const rawData = fs.readFileSync('./pancakeswap-v3-base-subgraph-schema.json', 'utf8');
    schemaData = JSON.parse(rawData);
  } catch (error) {
    console.error('Error reading or parsing schema file:', error.message);
    return;
  }

  const schema = schemaData?.data?.__schema;
  if (!schema) {
    console.error('Could not find __schema in the provided file.');
    return;
  }

  console.log('Listing all OBJECT types and their fields:\n');

  const objectTypes = schema.types.filter(type => type.kind === 'OBJECT' && type.fields);

  if (objectTypes.length === 0) {
    console.log('No object types with fields found.');
    return;
  }

  objectTypes.forEach(type => {
    console.log(`========================================`);
    console.log(`Type: ${type.name}`);
    console.log(`----------------------------------------`);
    if (type.fields.length > 0) {
      type.fields.forEach(field => {
        console.log(`- ${field.name}`);
      });
    } else {
      console.log('No fields.');
    }
    console.log(`========================================\n`);
  });
}

main();
