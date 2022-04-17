// Copyright (c) 2019 ml5
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

/* eslint prefer-destructuring: ["error", {AssignmentExpression: {array: false}}] */
/* eslint no-await-in-loop: "off" */

/*
 * BodyPix: Real-time Person Segmentation in the Browser
 * Ported and integrated from all the hard work by: https://github.com/tensorflow/tfjs-models/tree/master/body-pix
 */

// @ts-check
import * as tf from '@tensorflow/tfjs';
import * as bp from '@tensorflow-models/body-pix';
import callCallback from '../utils/callcallback';
import generatedImageResult from '../utils/generatedImageResult';
import p5Utils from '../utils/p5Utils';
import BODYPIX_PALETTE from './BODYPIX_PALETTE';

const DEFAULTS = {
  "multiplier": 0.75,
  "outputStride": 16,
  "segmentationThreshold": 0.5,
  "palette": BODYPIX_PALETTE,
  "returnTensors": false,
}

class BodyPix {
  /**
     * Create BodyPix.
     * @param {HTMLVideoElement} video - An HTMLVideoElement.
     * @param {{
     *  multiplier: Number;
     *  outputStride: Number;
     *  segmentationThreshold: Number;
     *  palette: Object;
     *  returnTensors: Boolean;
     * }} options - An object with options.
     * @param {Function} callback - A callback to be called when the model is ready.
     */
  constructor(video, options, callback) {
    this.video = video;
    this.model = null;
    this.modelReady = false;
    this.modelPath = ''
    this.config = {
      multiplier: options.multiplier || DEFAULTS.multiplier,
      outputStride: options.outputStride || DEFAULTS.outputStride,
      segmentationThreshold: options.segmentationThreshold || DEFAULTS.segmentationThreshold,
      palette: options.palette || DEFAULTS.palette,
      returnTensors: options.returnTensors || DEFAULTS.returnTensors
    }

    this.ready = callCallback(this.loadModel(), callback);
  }

  /**
     * Load the model and set it to this.model
     * @return {Promise<Object>} the BodyPix model.
     */
  async loadModel() {
    this.model = await bp.load(this.config.multiplier);
    this.modelReady = true;
    return this;
  }

  /**
     * Returns an rgb array
     * @param {Object} p5ColorObj - a p5.Color obj
     * @return {Array} an [r,g,b] array
     */
  /* eslint class-methods-use-this: "off" */
  p5Color2RGB(p5ColorObj) {
    const regExp = /\(([^)]+)\)/;
    const match = regExp.exec(p5ColorObj.toString('rgb'));
    const [r, g, b] = match[1].split(',')
    return [r, g, b]
  }

  /**
     * Returns a bodyPartsSpec object 
     * @param {Array} colorOptions - an array of [r,g,b] colors
     * @return {object} an object with the bodyParts by color and id
     */
  /* eslint class-methods-use-this: "off" */
  bodyPartsSpec(colorOptions) {
    const result = colorOptions !== undefined || Object.keys(colorOptions).length >= 24 ? colorOptions : this.config.palette;

    // Check if we're getting p5 colors, make sure they are rgb
    const p5 = p5Utils.p5Instance;
    if (p5 && result !== undefined && Object.keys(result).length >= 24) {
      // Ensure the p5Color object is an RGB array
      Object.keys(result).forEach(part => {
        if (result[part].color instanceof p5.Color) {
          result[part].color = this.p5Color2RGB(result[part].color);
        }
      });
    }

    return result;
  }

  /**
     * Segments the image with partSegmentation, return result object
     * @param {HTMLImageElement | HTMLCanvasElement | object | function | number} imgToSegment - 
     *    takes any of the following params
     * @param {object} segmentationOptions - config params for the segmentation
     *    includes outputStride, segmentationThreshold
     * @return {Promise<Object>} a result object with image, raw, bodyParts
     */
  async segmentWithPartsInternal(imgToSegment, segmentationOptions) {
    // estimatePartSegmentation
    await this.ready;
    await tf.nextFrame();

    if (this.video && this.video.readyState === 0) {
      await new Promise(resolve => {
        this.video.onloadeddata = () => resolve();
      });
    }

    this.config.palette = segmentationOptions.palette || this.config.palette;
    this.config.outputStride = segmentationOptions.outputStride || this.config.outputStride;
    this.config.segmentationThreshold = segmentationOptions.segmentationThreshold || this.config.segmentationThreshold;

    const segmentation = await this.model.estimatePartSegmentation(imgToSegment, this.config.outputStride, this.config.segmentationThreshold);

    const bodyPartsMeta = this.bodyPartsSpec(this.config.palette);
    const colorsArray = Object.keys(bodyPartsMeta).map(part => bodyPartsMeta[part].color)

    const result = {
      segmentation,
      raw: {
        personMask: null,
        backgroundMask: null,
        partMask: null
      },
      tensor: {
        personMask: null,
        backgroundMask: null,
        partMask: null,
      },
      personMask: null,
      backgroundMask: null,
      partMask: null,
      bodyParts: bodyPartsMeta
    };
    result.raw.backgroundMask = bp.toMaskImageData(segmentation, true);
    result.raw.personMask = bp.toMaskImageData(segmentation, false);
    result.raw.partMask = bp.toColoredPartImageData(segmentation, colorsArray);

    const {
      personMask,
      backgroundMask,
      partMask,
    } = tf.tidy(() => {
      let normTensor = tf.browser.fromPixels(imgToSegment);
      // create a tensor from the input image
      const alpha = tf.ones([segmentation.height, segmentation.width, 1]).tile([1, 1, 1]).mul(255)
      normTensor = normTensor.concat(alpha, 2)

      // create a tensor from the segmentation
      let maskPersonTensor = tf.tensor(segmentation.data, [segmentation.height, segmentation.width, 1]);
      let maskBackgroundTensor = tf.tensor(segmentation.data, [segmentation.height, segmentation.width, 1]);
      let partTensor = tf.tensor([...result.raw.partMask.data], [segmentation.height, segmentation.width, 4]);

      // multiply the segmentation and the inputImage
      maskPersonTensor = tf.cast(maskPersonTensor.add(0.2).sign().relu().mul(normTensor), 'int32')
      maskBackgroundTensor = tf.cast(maskBackgroundTensor.add(0.2).sign().neg().relu().mul(normTensor), 'int32')
      // TODO: handle removing background 
      partTensor = tf.cast(partTensor, 'int32')

      return {
        personMask: maskPersonTensor,
        backgroundMask: maskBackgroundTensor,
        partMask: partTensor
      }
    })

    const personMaskRes = await generatedImageResult(personMask, this.config);
    const bgMaskRes = await generatedImageResult(backgroundMask, this.config);
    const partMaskRes = await generatedImageResult(partMask, this.config);

    // if p5 exists, return p5 image. otherwise, return the pixels.
    result.personMask = personMaskRes.image || personMaskRes.raw;
    result.backgroundMask = bgMaskRes.image || bgMaskRes.raw;
    result.partMask = partMaskRes.image || partMaskRes.raw;

    if (this.config.returnTensors) {
      // return tensors
      result.tensor.personMask = personMask;
      result.tensor.backgroundMask = backgroundMask;
      result.tensor.partMask = partMask;
    }

    return result;

  }

  /**
     * Segments the image with partSegmentation
     * @param {HTMLImageElement | HTMLCanvasElement | object | function | number} optionsOrCallback - 
     *    takes any of the following params
     * @param {object} configOrCallback - config params for the segmentation
     *    includes palette, outputStride, segmentationThreshold
     * @param {function} cb - a callback function that handles the results of the function.
     * @return {Promise<Object>} a promise or the results of a given callback, cb.
     */
  async segmentWithParts(optionsOrCallback, configOrCallback, cb) {
    let imgToSegment = this.video;
    let callback;
    let segmentationOptions = this.config;

    // Handle the image to predict
    if (typeof optionsOrCallback === 'function') {
      imgToSegment = this.video;
      callback = optionsOrCallback;
      // clean the following conditional statement up!
    } else if (optionsOrCallback instanceof HTMLImageElement ||
            optionsOrCallback instanceof HTMLCanvasElement ||
            optionsOrCallback instanceof HTMLVideoElement ||
            optionsOrCallback instanceof ImageData) {
      imgToSegment = optionsOrCallback;
    } else if (typeof optionsOrCallback === 'object' && (optionsOrCallback.elt instanceof HTMLImageElement ||
                optionsOrCallback.elt instanceof HTMLCanvasElement ||
                optionsOrCallback.elt instanceof ImageData)) {
      imgToSegment = optionsOrCallback.elt; // Handle p5.js image
    } else if (typeof optionsOrCallback === 'object' && optionsOrCallback.canvas instanceof HTMLCanvasElement) {
      imgToSegment = optionsOrCallback.canvas; // Handle p5.js image
    } else if (typeof optionsOrCallback === 'object' && optionsOrCallback.elt instanceof HTMLVideoElement) {
      imgToSegment = optionsOrCallback.elt; // Handle p5.js image
    } else if (!(this.video instanceof HTMLVideoElement)) {
      // Handle unsupported input
      throw new Error(
        'No input image provided. If you want to classify a video, pass the video element in the constructor. ',
      );
    }

    if (typeof configOrCallback === 'object') {
      segmentationOptions = configOrCallback;
    } else if (typeof configOrCallback === 'function') {
      callback = configOrCallback;
    }

    if (typeof cb === 'function') {
      callback = cb;
    }

    return callCallback(this.segmentWithPartsInternal(imgToSegment, segmentationOptions), callback);

  }

  /**
     * Segments the image with personSegmentation, return result object
     * @param {HTMLImageElement | HTMLCanvasElement | object | function | number} imgToSegment - 
     *    takes any of the following params
     * @param {object} segmentationOptions - config params for the segmentation
     *    includes outputStride, segmentationThreshold
     * @return {Promise<Object>} a result object with maskBackground, maskPerson, raw
     */
  async segmentInternal(imgToSegment, segmentationOptions) {

    await this.ready;
    await tf.nextFrame();

    if (this.video && this.video.readyState === 0) {
      await new Promise(resolve => {
        this.video.onloadeddata = () => resolve();
      });
    }

    this.config.outputStride = segmentationOptions.outputStride || this.config.outputStride;
    this.config.segmentationThreshold = segmentationOptions.segmentationThreshold || this.config.segmentationThreshold;

    const segmentation = await this.model.estimatePersonSegmentation(imgToSegment, this.config.outputStride, this.config.segmentationThreshold)

    const result = {
      segmentation,
      raw: {
        personMask: null,
        backgroundMask: null,
      },
      tensor: {
        personMask: null,
        backgroundMask: null,
      },
      personMask: null,
      backgroundMask: null,
    };
    result.raw.backgroundMask = bp.toMaskImageData(segmentation, true);
    result.raw.personMask = bp.toMaskImageData(segmentation, false);

    // TODO: consider returning the canvas with the bp.drawMask()
    // const bgMaskCanvas = document.createElement('canvas');
    // bgMaskCanvas.width = segmentation.width;
    // bgMaskCanvas.height = segmentation.height;
    // bp.drawMask(bgMaskCanvas, imgToSegment, result.maskBackground, 1, 3, false);

    // const featureMaskCanvas = document.createElement('canvas');
    // featureMaskCanvas.width = segmentation.width;
    // featureMaskCanvas.height = segmentation.height;
    // bp.drawMask(featureMaskCanvas, imgToSegment, result.maskPerson, 1, 3, false);

    // result.backgroundMask = bgMaskCanvas;
    // result.featureMask = featureMaskCanvas;

    const {
      personMask,
      backgroundMask
    } = tf.tidy(() => {
      let normTensor = tf.browser.fromPixels(imgToSegment);
      // create a tensor from the input image
      const alpha = tf.ones([segmentation.height, segmentation.width, 1]).tile([1, 1, 1]).mul(255)
      normTensor = normTensor.concat(alpha, 2)
      // normTensor.print();

      // create a tensor from the segmentation
      let maskPersonTensor = tf.tensor(segmentation.data, [segmentation.height, segmentation.width, 1]);
      let maskBackgroundTensor = tf.tensor(segmentation.data, [segmentation.height, segmentation.width, 1]);

      // multiply the segmentation and the inputImage
      maskPersonTensor = tf.cast(maskPersonTensor.neg().add(1).mul(normTensor), 'int32')
      maskBackgroundTensor = tf.cast(maskBackgroundTensor.mul(normTensor), 'int32')

      return {
        personMask: maskPersonTensor,
        backgroundMask: maskBackgroundTensor,
      }
    })

    const personMaskRes = await generatedImageResult(personMask, this.config);
    const bgMaskRes = await generatedImageResult(backgroundMask, this.config);

    // if p5 exists, return p5 image. otherwise, return the pixels.
    result.personMask = personMaskRes.image || personMaskRes.raw;
    result.backgroundMask = bgMaskRes.image || bgMaskRes.raw;

    if (this.config.returnTensors) {
      // return tensors
      result.tensor.personMask = personMask;
      result.tensor.backgroundMask = backgroundMask;
    }

    return result;

  }

  /**
     * Segments the image with personSegmentation
     * @param {HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | object | function | number} optionsOrCallback - 
     *    takes any of the following params
     * @param {object} configOrCallback - config params for the segmentation
     *    includes outputStride, segmentationThreshold
     * @param {function} cb - a callback function that handles the results of the function.
     * @return {Promise<Object>} a promise or the results of a given callback, cb.
     */
  async segment(optionsOrCallback, configOrCallback, cb) {
    let imgToSegment = this.video;
    let callback;
    let segmentationOptions = this.config;

    // Handle the image to predict
    if (typeof optionsOrCallback === 'function') {
      imgToSegment = this.video;
      callback = optionsOrCallback;
      // clean the following conditional statement up!
    } else if (optionsOrCallback instanceof HTMLImageElement ||
            optionsOrCallback instanceof HTMLCanvasElement ||
            optionsOrCallback instanceof HTMLVideoElement ||
            optionsOrCallback instanceof ImageData) {
      imgToSegment = optionsOrCallback;
    } else if (typeof optionsOrCallback === 'object' && (optionsOrCallback.elt instanceof HTMLImageElement ||
                optionsOrCallback.elt instanceof HTMLCanvasElement ||
                optionsOrCallback.elt instanceof ImageData)) {
      imgToSegment = optionsOrCallback.elt; // Handle p5.js image
    } else if (typeof optionsOrCallback === 'object' && optionsOrCallback.canvas instanceof HTMLCanvasElement) {
      imgToSegment = optionsOrCallback.canvas; // Handle p5.js image
    } else if (typeof optionsOrCallback === 'object' && optionsOrCallback.elt instanceof HTMLVideoElement) {
      imgToSegment = optionsOrCallback.elt; // Handle p5.js image
    } else if (!(this.video instanceof HTMLVideoElement)) {
      // Handle unsupported input
      throw new Error(
        'No input image provided. If you want to classify a video, pass the video element in the constructor. ',
      );
    }

    if (typeof configOrCallback === 'object') {
      segmentationOptions = configOrCallback;
    } else if (typeof configOrCallback === 'function') {
      callback = configOrCallback;
    }

    if (typeof cb === 'function') {
      callback = cb;
    }

    return callCallback(this.segmentInternal(imgToSegment, segmentationOptions), callback);
  }

}

/**
 * 
 * @param {Object | Function} videoOrOptionsOrCallback 
 * @param {Object | Function} optionsOrCallback 
 * @param {Function} cb 
 * @returns {Promise<Object> | Function}
 */
const bodyPix = (videoOrOptionsOrCallback, optionsOrCallback, cb) => {
  let video;
  let options = {};
  let callback = cb;

  if (videoOrOptionsOrCallback instanceof HTMLVideoElement) {
    video = videoOrOptionsOrCallback;
  } else if (
    typeof videoOrOptionsOrCallback === 'object' &&
        videoOrOptionsOrCallback.elt instanceof HTMLVideoElement
  ) {
    video = videoOrOptionsOrCallback.elt; // Handle a p5.js video element
  } else if (typeof videoOrOptionsOrCallback === 'object') {
    options = videoOrOptionsOrCallback;
  } else if (typeof videoOrOptionsOrCallback === 'function') {
    callback = videoOrOptionsOrCallback;
  }

  if (typeof optionsOrCallback === 'object') {
    options = optionsOrCallback;
  } else if (typeof optionsOrCallback === 'function') {
    callback = optionsOrCallback;
  }

  const instance = new BodyPix(video, options, callback);
  return callback ? instance : instance.ready;
}

export default bodyPix;
