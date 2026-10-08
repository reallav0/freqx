//! Mic-only, borrowed-buffer ABI around the licensed libDF runtime.
//! Both PCM buffers live with the model; JS never passes an owned slice.
use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::{ArrayView2, ArrayViewMut2};

pub struct State {
    model: DfTract,
    input: [f32; 480],
    output: [f32; 480],
}

#[link(wasm_import_module = "freqx")]
extern "C" { fn random_fill(ptr: *mut u8, len: usize); }

// Used only for tract initialization, never for secrets or security decisions.
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(ptr: *mut u8, len: usize) -> Result<(), getrandom::Error> {
    random_fill(ptr, len);
    Ok(())
}

#[no_mangle]
pub extern "C" fn freqx_df_create(attenuation: f32, beta: f32) -> *mut State {
    let params = RuntimeParams::default_with_ch(1).with_atten_lim(attenuation).with_post_filter(beta);
    let model = DfTract::new(DfParams::default(), &params).expect("DFN3 initialization failed");
    assert_eq!(model.hop_size, 480);
    assert_eq!(model.sr, 48000);
    Box::into_raw(Box::new(State { model, input: [0.; 480], output: [0.; 480] }))
}

#[no_mangle]
pub unsafe extern "C" fn freqx_df_input_ptr(state: *mut State) -> *mut f32 { (*state).input.as_mut_ptr() }
#[no_mangle]
pub unsafe extern "C" fn freqx_df_output_ptr(state: *mut State) -> *mut f32 { (*state).output.as_mut_ptr() }
#[no_mangle]
pub unsafe extern "C" fn freqx_df_latency_samples(state: *const State) -> usize {
    let model = &(*state).model;
    model.fft_size - model.hop_size + model.lookahead * model.hop_size
}
#[no_mangle]
pub unsafe extern "C" fn freqx_df_process(state: *mut State) -> f32 {
    let state = &mut *state;
    state.model.process(
        ArrayView2::from_shape((1, 480), &state.input).unwrap(),
        ArrayViewMut2::from_shape((1, 480), &mut state.output).unwrap(),
    ).expect("DFN3 processing failed")
}
#[no_mangle]
pub unsafe extern "C" fn freqx_df_free(state: *mut State) { if !state.is_null() { drop(Box::from_raw(state)); } }
