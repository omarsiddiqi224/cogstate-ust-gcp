import React, { useRef, useState } from 'react';
import { FileUp, FileText, Loader2 } from 'lucide-react';
import { uploadFileApi, getSerializableFileInfo, validateFileSize } from '../end-points/uploadFile';
import { useNavigate } from 'react-router-dom';
import mockData from '../mock/mockData.json';

export default function FileUploader() {
  const fileInputRef = useRef();
  const navigate = useNavigate();
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const validTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/markdown'
  ];

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    const files = e.dataTransfer.files;
    if (files && files[0]) {
      handleFileSelection(files[0]);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      handleFileSelection(file);
    }
  };

  const handleFileSelection = (file) => {
    // Clear previous errors
    setUploadError(null);

    if (!validTypes.includes(file.type)) {
      const error = 'Invalid file type! Please upload PDF, Word, Excel or Markdown files.';
      setUploadError(error);
      alert(error);
      return;
    }

    // Validate file size
    try {
      validateFileSize(file);
    } catch (error) {
      setUploadError(error.message);
      alert(error.message);
      return;
    }
    
    setUploadedFile(file);
    console.log('File selected:', getSerializableFileInfo(file));
  };

  const handleUploadAndProcess = async () => {
    if (!uploadedFile) return;

    setIsUploading(true);
    setUploadError(null);
    
    try {
      console.log('Starting upload process...');
      console.log('File details:', getSerializableFileInfo(uploadedFile));
      
      const response = await uploadFileApi(uploadedFile, 'test');
      
      console.log('Upload successful! Response:', response);
      
      // Validate response structure
      if (!response) {
        throw new Error('No response received from server');
      }
      
      if (!response.id) {
        console.error('Response missing ID field:', response);
        throw new Error('Invalid response from server - missing document ID');
      }
      
      // Store response and navigate
      localStorage.setItem(`response_${response.id}`, JSON.stringify(response));
      console.log(`Stored response with ID: ${response.id}`);
      navigate(`/response/${response.id}`);
      
    } catch (error) {
      console.error('Upload failed with error:', error);
      
      let errorMessage = 'Upload failed. ';
      
      if (error.response) {
        // Server responded with error status
        const status = error.response.status;
        const data = error.response.data;
        
        if (status === 413) {
          errorMessage += 'File too large. Please try a smaller file.';
        } else if (status === 400) {
          errorMessage += data?.message || 'Invalid file or request.';
        } else if (status === 500) {
          errorMessage += 'Server error. Please try again later.';
        } else {
          errorMessage += `Server error (${status}). Please try again.`;
        }
      } else if (error.request) {
        // Network error
        errorMessage += 'Network error. Please check your connection and try again.';
      } else {
        // Other error
        errorMessage += error.message || 'Unknown error occurred.';
      }
      
      setUploadError(errorMessage);
      
      // Show error to user
      alert(errorMessage);
      
      // Only use mock data in development environment
      if (process.env.NODE_ENV === 'development') {
        console.warn('Development mode: Using mock data as fallback');
        
        const shouldUseMock = window.confirm(
          'Upload failed. Would you like to use mock data for testing? (Development mode only)'
        );
        
        if (shouldUseMock) {
          localStorage.setItem(`response_${mockData.id}`, JSON.stringify(mockData));
          navigate(`/response/${mockData.id}`);
        }
      }
    } finally {
      setIsUploading(false);
    }
  };

  const removeFile = () => {
    setUploadedFile(null);
    setUploadError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="bg-white pt-8 pb-12 px-10">
      <h1 className="text-xl font-bold text-primary mb-8">Upload New RFI/RFP Request Document</h1>
      
      {/* Error display */}
      {uploadError && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800 text-sm">{uploadError}</p>
        </div>
      )}
      
      {/* Loading Overlay */}
      {isUploading && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-8 text-center max-w-md mx-4">
            <Loader2 className="w-12 h-12 animate-spin text-blue-600 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Processing Your Document</h3>
            <p className="text-gray-600 mb-4">Please wait while we analyze your RFI/RFP document. Complex documents may take 5-15 minutes to process...</p>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-blue-600 h-2 rounded-full animate-pulse" style={{ width: '60%' }}></div>
            </div>
            <p className="text-sm text-gray-500 mt-2">Processing questions and generating AI responses...</p>
          </div>
        </div>
      )}

      <div className="flex gap-12">
        {/* Upload Area */}
        <div
          className={`flex-1 cursor-pointer flex flex-col items-center justify-center border-2 border-dashed border-secondary rounded-xl p-6 hover:bg-secondary/5 transition ${
            dragActive 
              ? 'border-secondary bg-blue-50' 
              : 'border-gray-300 hover:border-secondary/75'
          } ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}
          onClick={() => !isUploading && fileInputRef.current && fileInputRef.current.click()}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center justify-center">
            <div className="w-12 h-12 flex items-center justify-center mb-4">
              <FileUp size={60} strokeWidth={1} className="cursor-pointer text-secondary" />
            </div>
            <p className="text-sm font-medium text-secondary">Click to select a file</p>
            <p className="text-sm text-secondary mb-4">or drag and drop</p>
            <p className="text-xs text-gray-500 italic">Maximum file size is 10 MB</p>
            <p className="text-xs text-gray-500 italic mt-1">
              Supported: PDF, Word (.doc, .docx), Excel (.xls, .xlsx), Markdown (.md)
            </p>
            
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              id="file-upload"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.md"
              onChange={handleFileChange}
              disabled={isUploading}
            />
          </div>
        </div>

        {/* Uploads Panel */}
        <div className="flex-1 flex flex-col items-center justify-center border border-gray-300 rounded-xl p-6 transition min-h-64">
          <div className="border-b flex flex-col items-center justify-center border-gray-300 w-full mb-4">
            <h3 className="text font-semibold text-pr mb-4 w-full">Uploads</h3>
            {uploadedFile ? (
              <div className="p-2 mb-4 w-full">
                <div className="flex items-center gap-3">
                  <FileText size={20} strokeWidth={1.5} className="text-primary" />
                  <div className="flex-1">
                    <p className="text-xs font-medium text-gray-900 truncate">
                      {uploadedFile.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {Math.round(uploadedFile.size / 1024)} KB • {uploadedFile.type}
                    </p>
                  </div>
                  <button 
                    onClick={removeFile}
                    className="text-gray-400 hover:text-gray-600 rounded-full bg-light-gray p-1"
                    disabled={isUploading}
                  >
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center pb-8 text-gray-500">
                <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">No files uploaded yet</p>
              </div>
            )}
          </div>
          
          <button 
            onClick={handleUploadAndProcess}
            className={`flex items-center gap-2 py-2 px-10 rounded-full font-medium text-xs uppercase transition-colors ${
              isUploading
                ? 'bg-gray-400 text-gray-600 cursor-not-allowed'
                : uploadedFile
                ? 'bg-secondary text-white hover:bg-blue-700'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
            disabled={!uploadedFile || isUploading}
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing...
              </>
            ) : (
              'Upload & Process'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
