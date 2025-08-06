import axios from "../utils/axios-interceptor";

// Helper function to extract file extension from MIME type
const getFileExtension = (mimeType) => {
  const mimeToExtension = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/markdown': 'md'
  };
  
  return mimeToExtension[mimeType] || 'unknown';
};

// File size limit in bytes (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const validateFileSize = (file) => {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds the maximum limit of 10MB. Current file size: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
  }
  return true;
};

export const uploadFileApi = async (file, user = 'test') => {
  try {
    console.log('=== UPLOAD API START ===');
    console.log('File details:', {
      name: file.name,
      size: file.size,
      type: file.type,
      extension: getFileExtension(file.type)
    });
    
    // Validate file size before upload
    validateFileSize(file);
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('fileName', file.name);
    formData.append('fileType', getFileExtension(file.type)); // Send extension only
    formData.append('size', file.size.toString());
    formData.append('user', user); 

    console.log('FormData contents:');
    for (let pair of formData.entries()) {
      if (pair[1] instanceof File) {
        console.log(`${pair[0]}:`, `File(${pair[1].name}, ${pair[1].size} bytes)`);
      } else {
        console.log(`${pair[0]}:`, pair[1]);
      }
    }

    console.log('Making POST request to /draft-answers...');

    const res = await axios.post('/draft-answers', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      timeout: 3600000, // 1 hour timeout - for very complex documents
      onUploadProgress: (progressEvent) => {
        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        console.log(`Upload progress: ${percentCompleted}%`);
      },
    });
    
    console.log('=== UPLOAD API RESPONSE ===');
    console.log('Response status:', res.status);
    console.log('Response headers:', res.headers);
    console.log('Response data:', res.data);
    console.log('Response data type:', typeof res.data);
    
    // Validate response structure
    if (!res.data) {
      console.error('No response data received');
      throw new Error('No response data received from server');
    }
    
    console.log('Response data keys:', Object.keys(res.data));
    
    if (!res.data.id) {
      console.error('Response missing ID field. Full response:', res.data);
      throw new Error('Server response is missing document ID. Please try again.');
    }
    
    // Additional validation
    if (typeof res.data.id !== 'string' || res.data.id.trim() === '') {
      console.error('Invalid ID format:', res.data.id);
      throw new Error('Server returned invalid document ID format');
    }
    
    console.log(`✅ Upload successful! Document ID: ${res.data.id}`);
    console.log('=== UPLOAD API END ===');
    
    return res.data;
    
  } catch (error) {
    console.log('=== UPLOAD API ERROR ===');
    console.error('Upload API error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data,
      responseHeaders: error.response?.headers,
      requestConfig: {
        url: error.config?.url,
        method: error.config?.method,
        timeout: error.config?.timeout
      }
    });
    
    // Enhanced error handling
    if (error.response) {
      // Server responded with error status
      const status = error.response.status;
      const data = error.response.data;
      
      let errorMessage;
      switch (status) {
        case 400:
          errorMessage = data?.message || data?.error || 'Bad request - invalid file or parameters';
          break;
        case 401:
          errorMessage = 'Unauthorized - please check your credentials';
          break;
        case 413:
          errorMessage = 'File too large - please try a smaller file';
          break;
        case 415:
          errorMessage = 'Unsupported file type - please try a different file format';
          break;
        case 422:
          errorMessage = data?.message || 'File validation failed';
          break;
        case 429:
          errorMessage = 'Too many requests - please wait and try again';
          break;
        case 500:
          errorMessage = 'Internal server error - please try again later';
          break;
        case 502:
        case 503:
        case 504:
          errorMessage = 'Service temporarily unavailable - please try again later';
          break;
        default:
          errorMessage = data?.message || data?.error || `Server error (${status})`;
      }
      
      const enhancedError = new Error(errorMessage);
      enhancedError.status = status;
      enhancedError.response = error.response;
      throw enhancedError;
      
    } else if (error.request) {
      // Network error - no response received
      console.error('Network error - no response received:', error.request);
      
      if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout - the document processing exceeded 1 hour. This usually indicates a very large or complex document. Please try with a smaller document or contact support.');
      } else if (error.code === 'NETWORK_ERROR') {
        throw new Error('Network error - please check your internet connection and try again.');
      } else {
        throw new Error('Network error - unable to reach the server. Please check your connection and try again.');
      }
      
    } else {
      // Request setup error
      console.error('Request setup error:', error.message);
      throw new Error(`Request failed: ${error.message}`);
    }
  }
};

export const getSerializableFileInfo = (file) => ({
  name: file.name,
  type: file.type,
  size: file.size,
  lastModified: file.lastModified,
  lastModifiedDate: file.lastModified ? new Date(file.lastModified).toISOString() : null
});

// Additional utility function for testing
export const testConnection = async () => {
  try {
    console.log('Testing connection to backend...');
    const response = await axios.get('/health', { timeout: 5000 });
    console.log('Connection test successful:', response.data);
    return true;
  } catch (error) {
    console.error('Connection test failed:', error.message);
    return false;
  }
};
