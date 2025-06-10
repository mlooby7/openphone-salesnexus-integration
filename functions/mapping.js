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

    // Route based on path and method
    if (method === 'GET' && segments.length === 0) {
      return await getMappings(event, headers);
    } else if (method === 'GET' && segments.length === 1) {
      return await getMappingByPhone(segments[0], headers);
    } else if (method === 'POST' && segments.length === 0) {
      return await saveMappings(event, headers);
    } else if (method === 'DELETE' && segments.length === 1) {
      return await deleteMapping(segments[0], headers);
    } else if (method === 'POST' && segments[0] === 'lookup') {
      return await lookupEmailByPhone(event, headers);
    } else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Route not found' })
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
      if (!search || 
          data.phoneNumber.includes(search) || 
          (data.emails && data.emails.some(email => email.includes(search))) ||
          (data.email && data.email.includes(search))) {
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

// Save one or more mappings - UPDATED TO HANDLE MULTIPLE EMAILS PER PHONE
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
    
    // Group mappings by phone number to handle multiple emails
    const phoneToEmails = {};
    for (const mapping of mappings) {
      if (!phoneToEmails[mapping.phoneNumber]) {
        phoneToEmails[mapping.phoneNumber] = [];
      }
      phoneToEmails[mapping.phoneNumber].push(mapping.email);
    }
    
    // Save mappings with multiple email support
    const mappingsCollection = db.collection('phoneEmailMappings');
    const batch = db.batch();
    
    for (const [phoneNumber, emails] of Object.entries(phoneToEmails)) {
      const docRef = mappingsCollection.doc(phoneNumber);
      
      // Check if document already exists
      const existingDoc = await docRef.get();
      let finalEmails = emails;
      
      if (existingDoc.exists) {
        const existingData = existingDoc.data();
        let existingEmails = [];
        
        // Handle both old format (single email) and new format (array of emails)
        if (existingData.emails && Array.isArray(existingData.emails)) {
          existingEmails = existingData.emails;
        } else if (existingData.email) {
          existingEmails = [existingData.email];
        }
        
        // Merge emails, removing duplicates
        const allEmails = [...existingEmails, ...emails];
        finalEmails = [...new Set(allEmails)]; // Remove duplicates
        console.log(`Merging emails for ${phoneNumber}: ${finalEmails.join(', ')}`);
      }
      
      batch.set(docRef, {
        emails: finalEmails, // Store as array of emails
        phoneNumber: phoneNumber,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Keep legacy email field for backward compatibility (first email)
        email: finalEmails[0]
      });
    }
    
    await batch.commit();
    console.log(`Successfully saved mappings for ${Object.keys(phoneToEmails).length} phone numbers`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        phoneNumbers: Object.keys(phoneToEmails).length,
        totalEmails: mappings.length 
      })
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

// FIXED: Lookup ALL emails by phone number (for webhook handler)
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
    
    console.log(`Looking up emails for phone: ${formattedPhone}`);
    
    const mappingsCollection = db.collection('phoneEmailMappings');
    const doc = await mappingsCollection.doc(formattedPhone).get();
    
    if (!doc.exists) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'No mapping found for this phone number' })
      };
    }
    
    const data = doc.data();
    let emails = [];
    
    // Handle both new format (emails array) and old format (single email)
    if (data.emails && Array.isArray(data.emails)) {
      emails = data.emails;
    } else if (data.email) {
      emails = [data.email];
    }
    
    console.log(`Found ${emails.length} emails for phone ${formattedPhone}: ${emails.join(', ')}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        emails: emails,           // Return ALL emails as array
        email: emails[0],         // Keep legacy single email field for backward compatibility
        count: emails.length      // Number of emails found
      })
    };
  } catch (error) {
    console.error('Error looking up emails by phone:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Failed to lookup emails', 
        message: error.message,
        code: error.code
      })
    };
  }
}
