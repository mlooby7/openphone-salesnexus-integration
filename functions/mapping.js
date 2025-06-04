const admin = require('firebase-admin');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-b8gbi%40sweet-liger-902232.iam.gserviceaccount.com",
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`
    })
  });
}

const db = admin.firestore();

function cleanPhoneNumber(phone) {
  if (!phone) return '';
  return phone.replace(/[\s\-\(\)\.]/g, '');
}

function formatPhoneForE164(phone) {
  const cleaned = cleanPhoneNumber(phone);
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('1') && cleaned.length === 11) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  return `+${cleaned}`;
}

// Helper function to normalize phone numbers for comparison
function normalizePhoneForLookup(phone) {
  if (!phone) return '';
  
  // Remove all formatting
  const digitsOnly = phone.replace(/\D/g, '');
  
  // If it starts with 1 and has 11 digits, remove the 1
  if (digitsOnly.startsWith('1') && digitsOnly.length === 11) {
    return digitsOnly.substring(1);
  }
  
  // If it has 10 digits, return as is
  if (digitsOnly.length === 10) {
    return digitsOnly;
  }
  
  return digitsOnly;
}

// Get mapping for webhook lookup (OpenPhone webhook calls this)
async function getEmailMapping(body, headers) {
  const { phoneNumber } = body;
  
  if (!phoneNumber) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Phone number is required' })
    };
  }

  try {
    console.log(`Looking up phone number: ${phoneNumber}`);
    
    // Normalize the incoming phone number
    const normalizedIncoming = normalizePhoneForLookup(phoneNumber);
    console.log(`Normalized incoming: ${normalizedIncoming}`);
    
    // Get all mappings from Firestore
    const mappingsCollection = db.collection('phoneEmailMappings');
    const snapshot = await mappingsCollection.get();
    
    console.log(`Retrieved ${snapshot.size} documents from Firestore`);
    
    // Search through all mappings for a match
    let foundMapping = null;
    
    snapshot.forEach(doc => {
      const data = doc.data();
      const storedPhone = data.phoneNumber;
      const normalizedStored = normalizePhoneForLookup(storedPhone);
      
      console.log(`Comparing ${normalizedIncoming} with stored ${normalizedStored} (original: ${storedPhone})`);
      
      if (normalizedIncoming === normalizedStored) {
        foundMapping = data;
        console.log(`Found match! Email: ${data.email}`);
      }
    });
    
    if (foundMapping) {
      console.log(`Found email mapping: ${foundMapping.email} for phone: ${phoneNumber}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          email: foundMapping.email,
          contactName: foundMapping.contactName || '',
          companyName: foundMapping.companyName || ''
        })
      };
    } else {
      console.log(`No mapping found for phone: ${phoneNumber}`);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'No mapping found' })
      };
    }
    
  } catch (error) {
    console.error('Error looking up mapping:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to lookup mapping', 
        message: error.message
      })
    };
  }
}

// Get mappings for frontend display
async function getFrontendMappings(body, headers) {
  const { search = '' } = body;
  
  try {
    console.log('Getting mappings from Firestore for frontend...');
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    const snapshot = await mappingsCollection.get();
    
    console.log(`Retrieved ${snapshot.size} documents from Firestore`);
    
    let results = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      results.push({
        id: doc.id,
        phoneNumber: data.phoneNumber,
        email: data.email,
        contactName: data.contactName || '',
        companyName: data.companyName || ''
      });
    });
    
    // Apply search filter if provided
    if (search && search.trim()) {
      const searchTerm = search.toLowerCase().trim();
      results = results.filter(mapping => {
        return (
          (mapping.phoneNumber && mapping.phoneNumber.toLowerCase().includes(searchTerm)) ||
          (mapping.email && mapping.email.toLowerCase().includes(searchTerm)) ||
          (mapping.contactName && mapping.contactName.toLowerCase().includes(searchTerm)) ||
          (mapping.companyName && mapping.companyName.toLowerCase().includes(searchTerm))
        );
      });
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ mappings: results })
    };
    
  } catch (error) {
    console.error('Error getting frontend mappings:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to get mappings', 
        message: error.message
      })
    };
  }
}

// Upload CSV mappings
async function uploadMappings(body, headers) {
  const { csvData } = body;
  
  if (!csvData) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'CSV data is required' })
    };
  }

  try {
    console.log('Processing CSV data...');
    
    const Papa = require('papaparse');
    const parsed = Papa.parse(csvData, {
      header: true,
      skipEmptyLines: true
    });
    
    if (parsed.errors.length > 0) {
      console.error('CSV parsing errors:', parsed.errors);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'CSV parsing failed', 
          details: parsed.errors 
        })
      };
    }
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    const batch = db.batch();
    
    let validCount = 0;
    let errors = [];
    
    for (const row of parsed.data) {
      try {
        // Flexible field mapping
        const phoneField = row['Phone'] || row['phone'] || row['Phone Number'] || row['phone_number'];
        const emailField = row['Email'] || row['email'] || row['Email Address'] || row['email_address'];
        const nameField = row['Name'] || row['name'] || row['Contact Name'] || row['contact_name'] || 
                         row['First Name'] || row['first_name'] || row['Full Name'] || row['full_name'];
        const companyField = row['Company'] || row['company'] || row['Company Name'] || row['company_name'] ||
                           row['Business'] || row['business'] || row['Organization'] || row['organization'];
        
        if (!phoneField || !emailField) {
          errors.push(`Missing phone or email in row: ${JSON.stringify(row)}`);
          continue;
        }
        
        const formattedPhone = formatPhoneForE164(phoneField);
        
        // Create a document with phone number as the ID for easy lookup
        const docRef = mappingsCollection.doc();
        batch.set(docRef, {
          phoneNumber: formattedPhone,
          email: emailField.trim(),
          contactName: nameField ? nameField.trim() : '',
          companyName: companyField ? companyField.trim() : '',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        validCount++;
      } catch (error) {
        errors.push(`Error processing row ${JSON.stringify(row)}: ${error.message}`);
      }
    }
    
    if (validCount === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'No valid mappings found in CSV',
          details: errors
        })
      };
    }
    
    await batch.commit();
    console.log(`Successfully uploaded ${validCount} mappings`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        message: `Successfully uploaded ${validCount} mappings`,
        validCount,
        errors: errors.length > 0 ? errors : undefined
      })
    };
    
  } catch (error) {
    console.error('Error uploading mappings:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to upload mappings', 
        message: error.message
      })
    };
  }
}

// Add single mapping
async function addMapping(body, headers) {
  const { phoneNumber, email, contactName = '', companyName = '' } = body;
  
  if (!phoneNumber || !email) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Phone number and email are required' })
    };
  }

  try {
    const formattedPhone = formatPhoneForE164(phoneNumber);
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    const docRef = mappingsCollection.doc();
    
    await docRef.set({
      phoneNumber: formattedPhone,
      email: email.trim(),
      contactName: contactName.trim(),
      companyName: companyName.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`Added mapping: ${formattedPhone} -> ${email}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        message: 'Mapping added successfully',
        mapping: {
          phoneNumber: formattedPhone,
          email: email.trim(),
          contactName: contactName.trim(),
          companyName: companyName.trim()
        }
      })
    };
    
  } catch (error) {
    console.error('Error adding mapping:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to add mapping', 
        message: error.message
      })
    };
  }
}

// Clear all mappings
async function clearMappings(body, headers) {
  try {
    console.log('Clearing all mappings...');
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    const snapshot = await mappingsCollection.get();
    
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    console.log(`Cleared ${snapshot.size} mappings`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        message: `Successfully cleared ${snapshot.size} mappings` 
      })
    };
    
  } catch (error) {
    console.error('Error clearing mappings:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to clear mappings', 
        message: error.message
      })
    };
  }
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { action } = body;

    switch (action) {
      case 'getMapping':
        return await getEmailMapping(body, headers);
      case 'getMappings':
        return await getFrontendMappings(body, headers);
      case 'uploadMappings':
        return await uploadMappings(body, headers);
      case 'addMapping':
        return await addMapping(body, headers);
      case 'clearMappings':
        return await clearMappings(body, headers);
      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid action' })
        };
    }
  } catch (error) {
    console.error('Handler error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error', 
        message: error.message 
      })
    };
  }
};
