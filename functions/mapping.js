const admin = require('firebase-admin');

// Improved Firebase initialization with better error handling
let db = null;

function initializeFirebase() {
  try {
    // Check if already initialized
    if (admin.apps.length > 0) {
      db = admin.firestore();
      return true;
    }

    // Parse service account with better error handling
    let serviceAccount;
    try {
      if (typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string') {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      } else {
        serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
      }
    } catch (parseError) {
      console.error('Error parsing FIREBASE_SERVICE_ACCOUNT:', parseError);
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT format');
    }

    // Validate required fields
    if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
      throw new Error('Missing required fields in service account');
    }

    // Initialize Firebase Admin
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id
    });

    db = admin.firestore();
    console.log('Firebase initialized successfully');
    return true;

  } catch (error) {
    console.error('Firebase initialization failed:', error);
    console.error('Environment check:', {
      hasServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      serviceAccountLength: process.env.FIREBASE_SERVICE_ACCOUNT ? process.env.FIREBASE_SERVICE_ACCOUNT.length : 0,
      hasProjectId: !!process.env.FIREBASE_PROJECT_ID
    });
    return false;
  }
}

exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE'
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers
    };
  }

  // Initialize Firebase
  if (!initializeFirebase()) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Firebase initialization failed',
        message: 'Check server logs for configuration issues'
      })
    };
  }

  try {
    const path = event.path.replace('/.netlify/functions/mapping', '');
    const segments = path.split('/').filter(segment => segment);
    const method = event.httpMethod;

    console.log(`Processing ${method} request to path: ${path}`);

    // Handle POST requests to root path with action parameter (for frontend)
    if (method === 'POST' && segments.length === 0) {
      const body = JSON.parse(event.body);
      
      // Check if this is a frontend request with action parameter
      if (body.action) {
        return await handleFrontendAction(body, headers);
      } else {
        // Original batch save functionality
        return await saveMappings(event, headers);
      }
    }
    
    // Route based on path and method - check specific endpoints first
    if (method === 'GET' && segments[0] === 'count') {
      return await getCount(headers);
    } else if (method === 'POST' && segments[0] === 'lookup') {
      return await lookupEmailByPhone(event, headers);
    } else if (method === 'GET' && segments.length === 0) {
      return await getMappings(event, headers);
    } else if (method === 'GET' && segments.length === 1) {
      return await getMappingByPhone(segments[0], headers);
    } else if (method === 'DELETE' && segments.length === 1) {
      return await deleteMapping(segments[0], headers);
    } else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          error: 'Route not found',
          path: path,
          method: method,
          availableRoutes: ['/', '/lookup', '/count', '/{phoneNumber}']
        })
      };
    }
  } catch (error) {
    console.error('Error in router:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to process request', 
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
};

// Handle frontend actions (add, get, upload)
async function handleFrontendAction(body, headers) {
  const { action } = body;
  
  try {
    switch (action) {
      case 'add':
        return await addSingleMapping(body, headers);
      case 'get':
        return await getFrontendMappings(body, headers);
      case 'upload':
        return await uploadCSVMappings(body, headers);
      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: `Unknown action: ${action}` })
        };
    }
  } catch (error) {
    console.error(`Error handling frontend action ${action}:`, error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: `Failed to process ${action} action`, 
        message: error.message
      })
    };
  }
}

// Add single mapping from frontend
async function addSingleMapping(body, headers) {
  const { phoneNumber, email, contactName = '', companyName = '', phoneType = 'Manual Entry' } = body;
  
  if (!phoneNumber || !email) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Phone number and email are required' })
    };
  }
  
  if (!isValidEmail(email)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: `Invalid email format: ${email}` })
    };
  }
  
  const formattedPhone = formatPhoneNumber(phoneNumber);
  
  if (!formattedPhone) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid phone number format' })
    };
  }
  
  try {
    const mappingsCollection = db.collection('phoneEmailMappings');
    await mappingsCollection.doc(formattedPhone).set({
      email,
      phoneNumber: formattedPhone,
      contactName,
      companyName,
      phoneType,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`Successfully added mapping: ${formattedPhone} -> ${email}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true,
        message: `Successfully added mapping for ${formattedPhone}`
      })
    };
  } catch (error) {
    console.error('Error adding single mapping:', error);
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

// Get mappings for frontend (with search)
async function getFrontendMappings(body, headers) {
  const { search = '' } = body;
  
  try {
    console.log('Getting mappings from Firestore for frontend...');
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    const query = mappingsCollection.limit(10000);
    
    const snapshot = await query.get();
    console.log(`Retrieved ${snapshot.size} documents from Firestore`);
    
    let results = [];
    snapshot.forEach(doc => {
      results.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    // Filter by search if provided
    if (search) {
      results = results.filter(mapping => 
        mapping.phoneNumber.toLowerCase().includes(search.toLowerCase()) || 
        mapping.email.toLowerCase().includes(search.toLowerCase()) ||
        (mapping.contactName && mapping.contactName.toLowerCase().includes(search.toLowerCase())) ||
        (mapping.companyName && mapping.companyName.toLowerCase().includes(search.toLowerCase()))
      );
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

// Upload CSV mappings from frontend
async function uploadCSVMappings(body, headers) {
  const { csvContent } = body;
  
  if (!csvContent) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'CSV content is required' })
    };
  }
  
  try {
    const mappings = parseCSV(csvContent);
    
    if (mappings.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No valid mappings found in the CSV' })
      };
    }
    
    // Save mappings in batch
    const batch = db.batch();
    const mappingsCollection = db.collection('phoneEmailMappings');
    
    for (const mapping of mappings) {
      const docRef = mappingsCollection.doc(mapping.phoneNumber);
      batch.set(docRef, {
        ...mapping,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    await batch.commit();
    console.log(`Successfully uploaded ${mappings.length} mappings via CSV`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        count: mappings.length,
        message: `Successfully uploaded ${mappings.length} phone-to-email mappings`
      })
    };
  } catch (error) {
    console.error('Error uploading CSV mappings:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to upload CSV', 
        message: error.message
      })
    };
  }
}

// Parse CSV content
function parseCSV(csvContent) {
  const lines = csvContent.split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];
  
  const mappings = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
    const phoneNumber = formatPhoneNumber(values[0]);
    const email = values[1];
    
    if (phoneNumber && email && isValidEmail(email)) {
      mappings.push({
        phoneNumber,
        email,
        contactName: values[2] || '',
        companyName: values[3] || '',
        phoneType: values[4] || 'CSV Upload'
      });
    }
  }
  
  return mappings;
}

// Get count of mappings
async function getCount(headers) {
  try {
    const mappingsCollection = db.collection('phoneEmailMappings');
    const snapshot = await mappingsCollection.count().get();
    const count = snapshot.data().count;
    
    console.log(`Total mappings in database: ${count}`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ count })
    };
  } catch (error) {
    console.error('Error getting count:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to get count', 
        message: error.message
      })
    };
  }
}

// Format phone number to E.164 format
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters
  let digits = phone.replace(/\D/g, '');
  
  // Add country code if missing
  if (digits.length === 10) {
    digits = '1' + digits; // Assume US number
  }
  
  // Validate length (assuming international format)
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }
  
  return '+' + digits;
}

// Validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Get all mappings with optional search filter
async function getMappings(event, headers) {
  const { search, limit = 10000, startAfter } = event.queryStringParameters || {};
  
  try {
    console.log('Getting mappings from Firestore...');
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    let query = mappingsCollection.orderBy('phoneNumber');
    
    if (startAfter) {
      query = query.startAfter(startAfter);
    }
    
    query = query.limit(parseInt(limit));
    
    const snapshot = await query.get();
    console.log(`Retrieved ${snapshot.size} documents from Firestore`);
    
    const results = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // If search is provided, filter results client-side
      if (!search || data.phoneNumber.includes(search) || data.email.includes(search)) {
        results.push(data);
      }
    });
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        mappings: results,
        lastKey: snapshot.size > 0 ? snapshot.docs[snapshot.docs.length - 1].data().phoneNumber : null
      })
    };
  } catch (error) {
    console.error('Error getting mappings:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to get mappings', 
        message: error.message,
        code: error.code
      })
    };
  }
}

// Get mapping by phone number
async function getMappingByPhone(phoneNumber, headers) {
  try {
    console.log(`Getting mapping for phone: ${phoneNumber}`);
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    const doc = await mappingsCollection.doc(phoneNumber).get();
    
    if (!doc.exists) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Mapping not found' })
      };
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(doc.data())
    };
  } catch (error) {
    console.error('Error getting mapping:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to get mapping', 
        message: error.message,
        code: error.code
      })
    };
  }
}

// Save one or more mappings (original functionality)
async function saveMappings(event, headers) {
  try {
    console.log('Saving mappings...');
    
    const body = JSON.parse(event.body);
    const mappings = Array.isArray(body) ? body : [body];
    
    console.log(`Processing ${mappings.length} mappings`);
    
    // Validate mappings
    for (const mapping of mappings) {
      if (!mapping.phoneNumber || !mapping.email) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Phone number and email are required for each mapping' })
        };
      }
      
      if (!isValidEmail(mapping.email)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: `Invalid email format: ${mapping.email}` })
        };
      }
      
      // Format phone number
      mapping.phoneNumber = formatPhoneNumber(mapping.phoneNumber);
      
      if (!mapping.phoneNumber) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid phone number format' })
        };
      }
    }
    
    // Save mappings in batch
    const batch = db.batch();
    const mappingsCollection = db.collection('phoneEmailMappings');
    
    for (const mapping of mappings) {
      const docRef = mappingsCollection.doc(mapping.phoneNumber);
      batch.set(docRef, {
        email: mapping.email,
        phoneNumber: mapping.phoneNumber,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    await batch.commit();
    console.log(`Successfully saved ${mappings.length} mappings`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, count: mappings.length })
    };
  } catch (error) {
    console.error('Error saving mappings:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to save mappings', 
        message: error.message,
        code: error.code
      })
    };
  }
}

// Delete mapping by phone number
async function deleteMapping(phoneNumber, headers) {
  try {
    console.log(`Deleting mapping for phone: ${phoneNumber}`);
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    await mappingsCollection.doc(phoneNumber).delete();
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };
  } catch (error) {
    console.error('Error deleting mapping:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to delete mapping', 
        message: error.message,
        code: error.code
      })
    };
  }
}

// Lookup email by phone number (for webhook handler)
async function lookupEmailByPhone(event, headers) {
  try {
    const { phoneNumber } = JSON.parse(event.body);
    
    if (!phoneNumber) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Phone number is required' })
      };
    }
    
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    if (!formattedPhone) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid phone number format' })
      };
    }
    
    console.log(`Looking up email for phone: ${formattedPhone}`);
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    const doc = await mappingsCollection.doc(formattedPhone).get();
    
    if (!doc.exists) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'No mapping found for this phone number' })
      };
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ email: doc.data().email })
    };
  } catch (error) {
    console.error('Error looking up email by phone:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to lookup email', 
        message: error.message,
        code: error.code
      })
    };
  }
}
