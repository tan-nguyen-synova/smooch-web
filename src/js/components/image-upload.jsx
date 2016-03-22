import React, { Component } from 'react';
import { uploadImage } from 'services/conversation-service';

import { preventDefault } from 'utils/events';

export class ImageUpload extends Component {
    constructor(...args) {
        super(...args);
        this.onImageChange = this.onImageChange.bind(this);
    }

    onImageChange(e) {
        e.preventDefault();
        const files = this.refs.fileInput.files;
        // we only allow one file in the input, but let's handle it
        // as if we supported multiple ones
        return Promise.all(Array.from(files).map((file) => {
            // catch it to prevent an unhandled promise exception
            return uploadImage(file).catch(() => {
            });
        })).then(() => {
            // if the file input is not reset, a user can't pick the same
            // file twice in a row.
            this.refs.imageUploadForm.reset();
        });
    }

    render() {
        return <label className='btn btn-sk-link image-upload'>
                   <form ref='imageUploadForm'
                         onSubmit={ preventDefault }>
                       <input type='file'
                              accept='image/*'
                              onChange={ this.onImageChange }
                              ref='fileInput' />
                   </form>
                   <i className='fa fa-picture-o'></i>
               </label>;
    }
}
