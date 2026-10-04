import { useProductRuntime } from '../../product-runtime.js'

/** The product store instance, for calling actions from event handlers (`api.getState().createBinding(...)`). */
export const useProductApi = () => useProductRuntime().store
